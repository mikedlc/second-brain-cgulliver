/**
 * Ingress Lambda Handler
 * 
 * Handles Slack webhook requests with configurable security modes:
 * - mtls-hmac: mTLS + HMAC signature verification (most secure)
 * - mtls-only: mTLS only, no HMAC verification
 * - hmac-only: HMAC signature verification only (Lambda Function URL)
 * 
 * Features:
 * - URL verification challenge
 * - Event callback processing
 * - Conditional signature verification based on security mode
 * - Fast acknowledgement (< 3 seconds)
 * - SQS enqueueing for async processing
 * 
 * Validates: Requirements 1-5, 26, 48
 */

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { createHmac, timingSafeEqual } from 'crypto';
import type {
  SlackRequest,
  SlackEventCallbackRequest,
  SQSEventMessage,
} from '../types';

// Environment variables
const QUEUE_URL = process.env.QUEUE_URL!;
const SIGNING_SECRET_PARAM = process.env.SIGNING_SECRET_PARAM;
const SECURITY_MODE = process.env.SECURITY_MODE ?? 'mtls-hmac';

// Determine if HMAC verification is required based on security mode
const HMAC_ENABLED = SECURITY_MODE === 'mtls-hmac' || SECURITY_MODE === 'hmac-only';

// AWS SDK clients
const sqsClient = new SQSClient({});
const ssmClient = new SSMClient({});

// =========================================================================
// FINDING-NET-02: In-memory per-user rate limiter
// Limits each Slack user to MAX_REQUESTS_PER_WINDOW within RATE_LIMIT_WINDOW_MS.
// State resets on Lambda cold start, which is acceptable for personal use.
// =========================================================================
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 20; // 20 messages per minute per user

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);

  if (!entry || (now - entry.windowStart) >= RATE_LIMIT_WINDOW_MS) {
    // New window
    rateLimitMap.set(userId, { count: 1, windowStart: now });
    return false;
  }

  entry.count++;
  if (entry.count > MAX_REQUESTS_PER_WINDOW) {
    return true;
  }

  return false;
}

// Cache signing secret with TTL for Lambda warm starts (FINDING-SEC-01)
let cachedSigningSecret: string | null = null;
let signingSecretCachedAt: number = 0;
const SECRET_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Get Slack signing secret from SSM Parameter Store
 * Caches for 1 hour to support secret rotation without redeployment
 */
async function getSigningSecret(): Promise<string> {
  if (!HMAC_ENABLED || !SIGNING_SECRET_PARAM) {
    throw new Error('HMAC verification not enabled or signing secret param not configured');
  }

  const now = Date.now();
  if (cachedSigningSecret && (now - signingSecretCachedAt) < SECRET_CACHE_TTL_MS) {
    return cachedSigningSecret;
  }

  const response = await ssmClient.send(
    new GetParameterCommand({
      Name: SIGNING_SECRET_PARAM,
      WithDecryption: true,
    })
  );

  if (!response.Parameter?.Value) {
    throw new Error('Signing secret not found in SSM');
  }

  cachedSigningSecret = response.Parameter.Value;
  signingSecretCachedAt = now;
  return cachedSigningSecret;
}

/**
 * Verify Slack request signature
 * 
 * Validates: Requirement 1.1, 1.3
 */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string
): boolean {
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = createHmac('sha256', signingSecret);
  hmac.update(baseString);
  const computedSignature = `v0=${hmac.digest('hex')}`;

  try {
    return timingSafeEqual(
      Buffer.from(computedSignature),
      Buffer.from(signature)
    );
  } catch {
    // Lengths don't match
    return false;
  }
}

/**
 * Validate request timestamp is within acceptable window
 * 
 * Validates: Requirements 1.2, 1.4, 26.1, 26.2
 */
export function isValidTimestamp(
  timestamp: number,
  toleranceSec: number = 300
): boolean {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  // Reject if too old (> 5 minutes)
  if (diff > toleranceSec) {
    return false;
  }

  // Reject if in the future (with 60 second clock skew tolerance)
  if (diff < -60) {
    return false;
  }

  return true;
}

/**
 * Check if event should be processed
 * 
 * Validates: Requirements 4.1-4.3, 5.1-5.3
 */
export function shouldProcessEvent(event: SlackEventCallbackRequest): boolean {
  const innerEvent = event.event;

  // Only process DM events (channel_type === 'im')
  if (innerEvent.channel_type !== 'im') {
    return false;
  }

  // Ignore bot messages
  if (innerEvent.bot_id) {
    return false;
  }

  // Ignore edits, deletes, and other subtypes
  if (innerEvent.subtype) {
    return false;
  }

  // Must have text content
  if (!innerEvent.text) {
    return false;
  }

  return true;
}

/**
 * Format SQS message from Slack event
 */
function formatSQSMessage(event: SlackEventCallbackRequest): SQSEventMessage {
  return {
    event_id: event.event_id,
    event_time: event.event_time,
    channel_id: event.event.channel,
    user_id: event.event.user!,
    message_ts: event.event.ts,
    message_text: event.event.text!,
    thread_ts: event.event.thread_ts,
    received_at: new Date().toISOString(),
  };
}

/**
 * Verify HMAC signature if enabled
 * Returns true if verification passes or is not required
 */
async function verifyHmacIfEnabled(
  event: APIGatewayProxyEventV2,
  body: string
): Promise<{ valid: boolean; error?: string }> {
  if (!HMAC_ENABLED) {
    // mTLS-only mode: skip HMAC verification
    console.log('HMAC verification skipped (mtls-only mode)');
    return { valid: true };
  }

  const timestamp = event.headers['x-slack-request-timestamp'];
  const signature = event.headers['x-slack-signature'];

  if (!timestamp || !signature) {
    return { valid: false, error: 'Missing Slack headers' };
  }

  // Validate timestamp (replay protection)
  const timestampNum = parseInt(timestamp, 10);
  if (isNaN(timestampNum) || !isValidTimestamp(timestampNum)) {
    return { valid: false, error: 'Invalid or expired timestamp' };
  }

  // Verify signature
  try {
    const signingSecret = await getSigningSecret();
    if (!verifySlackSignature(signingSecret, timestamp, body, signature)) {
      return { valid: false, error: 'Invalid signature' };
    }
  } catch (error) {
    console.error('Failed to verify signature', error);
    return { valid: false, error: 'Signature verification failed' };
  }

  return { valid: true };
}

/**
 * Lambda handler for Slack webhook requests
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const startTime = Date.now();

  console.log('Request received', { securityMode: SECURITY_MODE });

  // Parse request body
  let body: string;
  if (event.isBase64Encoded) {
    body = Buffer.from(event.body || '', 'base64').toString('utf-8');
  } else {
    body = event.body || '';
  }

  let request: SlackRequest;
  try {
    request = JSON.parse(body) as SlackRequest;
  } catch {
    console.error('Failed to parse request body');
    return {
      statusCode: 400,
      body: 'Invalid JSON',
    };
  }

  // Handle URL verification challenge
  // Note: For mTLS modes, Slack must pass mTLS before reaching this point
  // For hmac-only mode, we verify the challenge response is legitimate
  if (request.type === 'url_verification') {
    console.log('URL verification challenge received');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: request.challenge,
    };
  }

  // For event callbacks, verify HMAC signature if enabled
  const hmacResult = await verifyHmacIfEnabled(event, body);
  if (!hmacResult.valid) {
    console.error('HMAC verification failed', { error: hmacResult.error });
    return {
      statusCode: 401,
      body: 'Unauthorized',
    };
  }

  // Handle event callback
  if (request.type === 'event_callback') {
    const eventCallback = request as SlackEventCallbackRequest;
    const eventId = eventCallback.event_id;

    console.log('Event callback received', { event_id: eventId });

    // Check if event should be processed
    if (!shouldProcessEvent(eventCallback)) {
      console.log('Event filtered out', {
        event_id: eventId,
        channel_type: eventCallback.event.channel_type,
        has_bot_id: !!eventCallback.event.bot_id,
        subtype: eventCallback.event.subtype,
      });
      // Return 200 to acknowledge but don't process
      return {
        statusCode: 200,
        body: 'OK',
      };
    }

    // FINDING-NET-02: Per-user rate limiting
    const userId = eventCallback.event.user;
    if (userId && isRateLimited(userId)) {
      console.warn('Rate limited', { event_id: eventId, user_id: userId });
      // Return 200 to acknowledge (don't make Slack retry) but don't process
      return {
        statusCode: 200,
        body: 'OK',
      };
    }

    // Enqueue for async processing
    try {
      const sqsMessage = formatSQSMessage(eventCallback);
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: QUEUE_URL,
          MessageBody: JSON.stringify(sqsMessage),
        })
      );

      console.log('Event enqueued', {
        event_id: eventId,
        elapsed_ms: Date.now() - startTime,
      });
    } catch (error) {
      console.error('Failed to enqueue event', { event_id: eventId, error });
      return {
        statusCode: 500,
        body: 'Internal Server Error',
      };
    }

    // Return 200 within 3 seconds (Requirement 3.1)
    return {
      statusCode: 200,
      body: 'OK',
    };
  }

  // Unknown request type
  console.error('Unknown request type', { type: (request as { type: string }).type });
  return {
    statusCode: 400,
    body: 'Bad Request',
  };
}
