# Security & Architecture Review

> Review Date: April 19, 2026
> Reviewer: Kiro (automated analysis)
> Commit: main branch (forked from cgulliver/aws-agentcore-second-brain)
> Purpose: Pre-deployment security assessment for personal AWS account (569708830775)

---

## Table of Contents

- [Executive Summary](#executive-summary)
- [Project Overview](#project-overview)
- [Data Flow](#data-flow)
- [IAM Permissions](#iam-permissions)
- [Secrets Management](#secrets-management)
- [Network Exposure](#network-exposure)
- [AI Agent Security](#ai-agent-security)
- [Cost Analysis](#cost-analysis)
- [Dependency Review](#dependency-review)
- [Monitoring & Observability](#monitoring--observability)
- [Findings Summary](#findings-summary)
- [Recommendations](#recommendations)

---

## Executive Summary

**Overall Security Posture: STRONG**

This is a well-designed serverless system with mature security practices including HMAC verification, mTLS support, idempotent processing, and proper secrets management. It is safe for deployment to a personal AWS account.

Key strengths:
- Defense-in-depth authentication (HMAC + optional mTLS)
- Secrets stored in SSM Parameter Store (SecureString, KMS-encrypted)
- All data encrypted at rest and in transit
- Idempotent processing prevents duplicate side effects
- AI agent returns JSON only — cannot execute code or make external calls

Key concerns:
- Several IAM policies use wildcard resources (fixable)
- No CloudWatch alarms configured (fixable)
- No per-user rate limiting on ingress
- Secret caching in Lambda has no TTL

Estimated monthly cost: ~$9/month at typical personal usage (~100 messages/day).

---

## Project Overview

A personal knowledge capture system that accepts Slack DMs and:
- Classifies messages as inbox, idea, decision, project, or task
- Stores knowledge items as Markdown in a CodeCommit git repo
- Routes tasks to a task manager (OmniFocus) via SES email
- Replies in Slack with confirmation and file paths

### Architecture

Two CDK stacks deploy ~25+ AWS resources:

| Stack | Resources |
|-------|-----------|
| **IngressStack** | Lambda, SQS + DLQ, API Gateway (mTLS) or Lambda Function URL |
| **CoreStack** | Worker Lambda, DynamoDB (2 tables), CodeCommit, ECR, CodeBuild, AgentCore Runtime + Memory, SES |

### Security Modes

| Mode | Description | Requirements |
|------|-------------|--------------|
| `mtls-hmac` | mTLS + HMAC signature verification (default, most secure) | Custom domain + Route 53 + ACM cert |
| `mtls-only` | mTLS certificate validation only | Custom domain + Route 53 + ACM cert |
| `hmac-only` | HMAC signature verification only | No domain required (Lambda Function URL) |

---

## Data Flow

### Message Processing Pipeline

```
1. Slack DM
   │
   ▼
2. Ingress Lambda (src/handlers/ingress.ts)
   ✅ HMAC verification (timing-safe comparison)
   ✅ Timestamp validation (rejects >5 min old)
   ✅ Event filtering (DM-only, ignores bots/edits)
   ✅ Enqueues to SQS, returns 200 within 3s
   │
   ▼
3. SQS Queue
   ✅ Encrypted at rest
   ✅ Visibility timeout: 90s
   ✅ DLQ for failed messages (3 retries)
   │
   ▼
4. Worker Lambda (src/handlers/worker.ts)
   ✅ Idempotency check via DynamoDB conditional write
   ✅ Loads system prompt from CodeCommit
   ✅ Invokes AgentCore classifier
   ✅ Validates returned Action Plan
   │
   ▼
5. AgentCore Runtime (agent/classifier.py)
   ✅ Bedrock model invocation (Nova Lite default)
   ✅ Memory integration for context
   ✅ Returns JSON Action Plan only
   │
   ▼
6. Side Effects (executed in order, partial failure recovery)
   a) CodeCommit: Write Markdown file + commit
   b) SES: Send email (if task classification)
   c) Slack: Send reply confirmation
   │
   ▼
7. Receipt Logging
   ✅ Appended to receipts file in CodeCommit
```

### Security at Each Step

| Step | Authentication | Encryption | Error Handling |
|------|---------------|------------|----------------|
| Slack → Ingress | HMAC + optional mTLS | HTTPS | Returns 200 immediately |
| Ingress → SQS | IAM role | Encrypted at rest | DLQ after 3 failures |
| SQS → Worker | IAM role | Encrypted at rest | Idempotency guard |
| Worker → AgentCore | IAM role | HTTPS | Timeout + retry |
| Worker → CodeCommit | IAM role | HTTPS | Partial failure recovery |
| Worker → SES | IAM role | HTTPS | Logged, non-blocking |
| Worker → Slack | Bot token (SSM) | HTTPS | Logged, non-blocking |

---

## IAM Permissions

### Status: GOOD with minor issues

Most policies follow least privilege with scoped resources and explicit action lists. Separate roles exist for AgentCore, CodeBuild, and Worker Lambda.

### Findings

#### FINDING-IAM-01: SES wildcard resource (HIGH)
- **File:** `lib/core-stack.ts` (Worker Lambda SES policy)
- **Issue:** `resources: ['*']` allows sending email from any SES identity
- **Risk:** If Lambda is compromised, attacker can send email as any verified identity
- **Fix:** Restrict to specific sender email ARN
- **Status:** [ ] Open

#### FINDING-IAM-02: AgentCore runtime wildcard (MEDIUM)
- **File:** `lib/core-stack.ts` (Worker Lambda AgentCore invoke policy)
- **Issue:** Second resource entry uses `arn:aws:bedrock-agentcore:${region}:${account}:runtime/*`
- **Risk:** Can invoke any AgentCore runtime in the account, not just the classifier
- **Fix:** Remove wildcard, use only the specific runtime ARN
- **Status:** [ ] Open

#### FINDING-IAM-03: Bedrock model invocation wildcard (MEDIUM)
- **File:** `lib/core-stack.ts` (AgentCore role Bedrock policy)
- **Issue:** `resources: ['*']` allows invoking any Bedrock model
- **Risk:** Could invoke expensive models (Claude Opus, etc.) if role is misused
- **Fix:** Restrict to specific model ARN: `arn:aws:bedrock:${region}::model/${classifierModel}`
- **Status:** [ ] Open

#### FINDING-IAM-04: ECR wildcard in CodeBuild role (LOW)
- **File:** `lib/core-stack.ts` (CodeBuild ECR policy)
- **Issue:** `resources: [this.ecrRepository.repositoryArn, '*']` — the `'*'` is for `GetAuthorizationToken` which requires it
- **Risk:** Low — `GetAuthorizationToken` legitimately requires `*` resource
- **Fix:** Split into two statements: one for `GetAuthorizationToken` with `*`, one for other ECR actions scoped to the repo
- **Status:** [ ] Open

---

## Secrets Management

### Status: GOOD

| Secret | Storage | Encrypted | Cached |
|--------|---------|-----------|--------|
| Slack signing secret | SSM SecureString | ✅ KMS | ✅ In Lambda memory |
| Slack bot token | SSM SecureString | ✅ KMS | ✅ In Lambda memory |
| OmniFocus mail drop email | SSM SecureString | ✅ KMS | ✅ In Lambda memory |
| SES sender email | SSM StringParameter | ✅ (not SecureString) | Via env var |
| ACM cert ARN | SSM StringParameter | ✅ | At synth time |
| Domain name | SSM StringParameter | ✅ | At synth time |

### Findings

#### FINDING-SEC-01: No cache TTL for secrets (MEDIUM)
- **File:** `src/components/action-executor.ts`
- **Issue:** Slack bot token and mail drop email are cached indefinitely in Lambda memory
- **Risk:** Secret rotation requires Lambda restart to take effect
- **Fix:** Add TTL-based cache invalidation (e.g., 1 hour)
- **Status:** [ ] Open

#### FINDING-SEC-02: SES sender email in environment variable (LOW)
- **File:** `lib/core-stack.ts`
- **Issue:** `SES_FROM_EMAIL` is set as a Lambda environment variable (visible in console)
- **Risk:** Low — email address is not highly sensitive
- **Fix:** Load from SSM at runtime instead (consistent with other secrets)
- **Status:** [ ] Open

---

## Network Exposure

### Status: STRONG

#### Publicly Accessible Endpoints

| Mode | Endpoint | Protection |
|------|----------|------------|
| `hmac-only` | Lambda Function URL | HMAC signature verification |
| `mtls-hmac` | API Gateway custom domain | mTLS + HMAC verification |
| `mtls-only` | API Gateway custom domain | mTLS certificate validation |

All other resources (DynamoDB, CodeCommit, SQS, SES, AgentCore) are internal AWS services accessed via IAM roles — no public endpoints.

### Findings

#### FINDING-NET-01: No IP whitelisting (LOW)
- **Issue:** Slack's IP ranges are not whitelisted at the API Gateway or Lambda Function URL level
- **Risk:** Any IP can attempt to connect (but HMAC/mTLS will reject unauthorized requests)
- **Fix:** Optional — add WAF rules to restrict to Slack's published IP ranges
- **Status:** [ ] Open (optional)

#### FINDING-NET-02: No rate limiting on ingress (MEDIUM)
- **Issue:** No per-user or per-IP throttling on the ingress endpoint
- **Risk:** Unlikely for personal use, but no protection against runaway invocations if webhook is misconfigured
- **Fix:** Add throttling in Ingress Lambda or API Gateway throttling settings
- **Status:** [ ] Open

---

## AI Agent Security

### Status: GOOD

The classifier agent (`agent/classifier.py`) runs on AgentCore Runtime and:
- Invokes a Bedrock model (Nova Lite by default) to classify messages
- Uses AgentCore Memory for context (existing items, user preferences)
- Returns a JSON Action Plan — does not execute code, make API calls, or access external systems
- Has read-only access to CodeCommit (for project matching)

### Findings

#### FINDING-AI-01: Prompt injection risk (MEDIUM)
- **File:** `system/agent-system-prompt.md`, `agent/classifier.py`
- **Issue:** User message is passed directly to the LLM without sanitization
- **Risk:** Malicious input like "ignore previous instructions" could alter classification behavior
- **Mitigating factors:** Agent only returns JSON, cannot execute actions on its own. Worker Lambda validates the Action Plan before executing side effects.
- **Fix:** Add input sanitization (strip control characters, limit length) before passing to classifier
- **Status:** [ ] Open

#### FINDING-AI-02: Model selection cost risk (LOW)
- **Issue:** Classifier model is configurable at deploy time via CDK context
- **Risk:** Accidentally deploying with Claude Haiku instead of Nova Lite could 10x costs
- **Fix:** Add cost warning in deploy script when non-default model is selected
- **Status:** [ ] Open

#### FINDING-AI-03: Extended thinking cost risk (LOW)
- **Issue:** Nova 2 extended thinking can be enabled via `reasoningEffort` context variable
- **Risk:** Increases token usage and latency (2-3x)
- **Fix:** Document cost implications, keep disabled by default (already the default)
- **Status:** [ ] Open

---

## Cost Analysis

### Estimated Monthly Cost (~100 messages/day)

| Service | Usage | Estimated Cost |
|---------|-------|---------------|
| AgentCore Runtime | Provisioned (fixed) | ~$5.00 |
| Bedrock (Nova Lite) | ~3,000 msgs/month × ~500 tokens | ~$1.50 |
| Lambda (Ingress + Worker) | ~6,000 invocations/month | ~$0.50 |
| DynamoDB (2 tables, on-demand) | ~3,000 writes/month | ~$0.25 |
| CodeCommit | 1 repository | $1.00 |
| CloudWatch Logs | ~100MB/month | ~$0.50 |
| SES | ~30 emails/month | ~$0.00 |
| S3 (mTLS truststore) | <1GB | ~$0.02 |
| **Total** | | **~$9/month** |

### Cost Risk Scenarios

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| Webhook spam (10,000 msgs/day) | ~$150/month | CloudWatch alarm on invocations |
| Model upgrade to Claude Haiku | ~$90/month | Deploy script cost warning |
| Extended thinking enabled (high) | ~$27/month | Default is disabled |
| Normal personal use | ~$9/month | No action needed |

### Findings

#### FINDING-COST-01: No CloudWatch alarms (HIGH)
- **Issue:** No alarms configured for Lambda invocations, errors, or Bedrock API calls
- **Risk:** Cost spikes or failures go unnoticed
- **Fix:** Add alarms for: Lambda invocations >1000/day, SQS DLQ messages >0, Lambda errors >5/hour
- **Status:** [ ] Open

---

## Dependency Review

### TypeScript (package.json)

- All dependencies use exact pinned versions (good)
- AWS SDK v3 packages present — some at v3.700.0 (older), some at v3.893.0
- Uses `@aws-crypto/sha256-js` for HMAC (AWS-maintained, audited)

### Python (agent/requirements.txt)

- 4 packages total (minimal)
- Uses `>=` version constraints (loose — could break on major bumps)

### Findings

#### FINDING-DEP-01: Loose Python version constraints (LOW)
- **File:** `agent/requirements.txt`
- **Issue:** `strands-agents>=0.1.0` and `bedrock-agentcore>=1.2.0` allow any future major version
- **Risk:** Breaking changes on upgrade
- **Fix:** Use upper bounds: `>=0.1.0,<1.0.0` and `>=1.2.0,<2.0.0`
- **Status:** [ ] Open

#### FINDING-DEP-02: No security scanning in pipeline (LOW)
- **Issue:** No `npm audit` or `pip audit` in deployment scripts
- **Fix:** Add security scanning step to deploy.sh
- **Status:** [ ] Open

---

## Monitoring & Observability

### Status: PARTIAL

| Capability | Implemented | Notes |
|------------|-------------|-------|
| CloudWatch Logs | ✅ | All Lambdas log to CloudWatch |
| Structured Logging | ✅ | JSON format |
| PII Redaction | ✅ | User IDs redacted |
| Receipt Audit Trail | ✅ | All operations logged to CodeCommit |
| Git History | ✅ | Full commit history in CodeCommit |
| CloudWatch Alarms | ❌ | None configured |
| CloudTrail | ❌ | Not enabled by this project |
| Log Retention Policy | ❌ | Uses CloudWatch defaults |

### Findings

#### FINDING-MON-01: No CloudWatch alarms (HIGH)
- See FINDING-COST-01 above
- **Status:** [ ] Open

#### FINDING-MON-02: No log retention policy (LOW)
- **Issue:** CloudWatch Logs use default retention (never expire)
- **Risk:** Accumulates storage costs and potentially sensitive data over time
- **Fix:** Set retention to 7-30 days
- **Status:** [ ] Open

#### FINDING-MON-03: No CloudTrail (LOW)
- **Issue:** AWS API calls not logged to CloudTrail
- **Risk:** Cannot audit infrastructure changes
- **Fix:** Enable CloudTrail at the account level (separate from this project)
- **Status:** [ ] Open

---

## Findings Summary

### By Priority

| ID | Priority | Category | Summary | Status |
|----|----------|----------|---------|--------|
| FINDING-COST-01 | 🔴 HIGH | Cost | No CloudWatch alarms configured | [x] Resolved |
| FINDING-IAM-01 | 🔴 HIGH | IAM | SES wildcard resource | [x] Resolved |
| FINDING-AI-01 | 🟡 MEDIUM | AI | Prompt injection risk (mitigated by JSON-only output) | [ ] Open |
| FINDING-IAM-02 | 🟡 MEDIUM | IAM | AgentCore runtime wildcard | [x] Resolved |
| FINDING-IAM-03 | 🟡 MEDIUM | IAM | Bedrock model invocation wildcard | [x] Resolved |
| FINDING-NET-02 | 🟡 MEDIUM | Network | No rate limiting on ingress | [ ] Open |
| FINDING-SEC-01 | 🟡 MEDIUM | Secrets | No cache TTL for secrets | [ ] Open |
| FINDING-IAM-04 | 🟢 LOW | IAM | ECR wildcard in CodeBuild role | [x] Resolved |
| FINDING-SEC-02 | 🟢 LOW | Secrets | SES sender email in env var | [ ] Open |
| FINDING-NET-01 | 🟢 LOW | Network | No IP whitelisting (optional) | [ ] Open |
| FINDING-AI-02 | 🟢 LOW | AI | Model selection cost risk | [ ] Open |
| FINDING-AI-03 | 🟢 LOW | AI | Extended thinking cost risk | [ ] Open |
| FINDING-DEP-01 | 🟢 LOW | Dependencies | Loose Python version constraints | [ ] Open |
| FINDING-DEP-02 | 🟢 LOW | Dependencies | No security scanning in pipeline | [ ] Open |
| FINDING-MON-02 | 🟢 LOW | Monitoring | No log retention policy | [ ] Open |
| FINDING-MON-03 | 🟢 LOW | Monitoring | No CloudTrail | [ ] Open |

### By Status

- **Open:** 11
- **Resolved:** 5

---

## Recommendations

### Before First Deploy

1. **Fix IAM wildcards** (FINDING-IAM-01, IAM-02, IAM-03) — ~30 minutes
2. **Add CloudWatch alarms** (FINDING-COST-01) — ~1 hour
3. **Deploy in `hmac-only` mode** — simplest setup, no custom domain needed, still secure

### After Deploy (Hardening)

4. Add input sanitization for prompt injection (FINDING-AI-01)
5. Add secret cache TTL (FINDING-SEC-01)
6. Add rate limiting on ingress (FINDING-NET-02)
7. Pin Python dependency versions (FINDING-DEP-01)
8. Set CloudWatch log retention (FINDING-MON-02)
9. Enable CloudTrail at account level (FINDING-MON-03)

### Ongoing

10. Run `npm audit` and `pip audit` periodically
11. Monitor monthly AWS bill for unexpected spikes
12. Review Bedrock model pricing if changing classifier model
