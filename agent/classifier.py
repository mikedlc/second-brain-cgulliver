"""
Second Brain Classifier Agent

Containerized AgentCore Runtime that classifies messages and generates Action Plans.
Uses Strands Agents with Bedrock for LLM inference.
Integrates with AgentCore Memory for behavioral learning and item context.

Features:
- Classification of messages into inbox, idea, decision, project, task
- Multi-item message detection and splitting
- Project reference detection (explicit and implicit)
- Memory integration for item context and behavioral learning
- Programmatic sync of CodeCommit items to Memory before classification

Validates: Requirements 6.3, 42.1, 58.1, 58.2
"""

import json
import os
from strands import Agent
from strands.models import BedrockModel
from bedrock_agentcore.runtime import BedrockAgentCoreApp

# AgentCore Memory integration (Task 25.1)
try:
    from bedrock_agentcore.memory import MemoryClient
    from bedrock_agentcore.memory.integrations.strands.config import (
        AgentCoreMemoryConfig,
        RetrievalConfig,
    )
    from bedrock_agentcore.memory.integrations.strands.session_manager import (
        AgentCoreMemorySessionManager,
    )
    MEMORY_AVAILABLE = True
except ImportError:
    MEMORY_AVAILABLE = False

# Item sync module for Memory-based item lookup
try:
    from item_sync import ItemSyncModule, ItemMetadata
    ITEM_SYNC_AVAILABLE = True
except ImportError:
    ITEM_SYNC_AVAILABLE = False
    # Define ItemMetadata stub for type hints when import fails
    ItemMetadata = None

app = BedrockAgentCoreApp()

# Environment variables
KNOWLEDGE_REPO_NAME = os.getenv('KNOWLEDGE_REPO_NAME', 'second-brain-knowledge')
AWS_REGION = os.getenv('AWS_DEFAULT_REGION', 'us-east-1')
MEMORY_ID = os.getenv('MEMORY_ID', '')  # Task 31.2: Memory ID from CDK
MODEL_ID = os.getenv('MODEL_ID', 'amazon.nova-micro-v1:0')  # Configurable model
# Nova 2 reasoning config: disabled, low, medium, high
REASONING_EFFORT = os.getenv('REASONING_EFFORT', 'disabled')

# Bypass tool consent for automated operation (no human in the loop)
os.environ['BYPASS_TOOL_CONSENT'] = 'true'


def is_nova_2_model(model_id: str) -> bool:
    """Check if the model supports Nova 2 extended thinking."""
    nova_2_patterns = ['nova-2-lite', 'nova-2-omni', 'nova-2-sonic']
    return any(pattern in model_id.lower() for pattern in nova_2_patterns)


def create_session_manager(user_id: str, session_id: str):
    """
    Create AgentCore Memory session manager for behavioral learning and item context.
    
    Task 25.1: Configure AgentCoreMemoryConfig with memory_id from environment.
    Task 25.2: Configure retrieval for user preferences and patterns.
    
    Namespaces:
    - /preferences/{actorId}: User classification preferences (from fix: commands)
    - /patterns/{actorId}: Learned patterns, cached knowledge, AND synced item metadata from CodeCommit
    
    Args:
        user_id: Slack user_id mapped to actor_id
        session_id: Conversation session identifier
    
    Returns:
        AgentCoreMemorySessionManager or None if Memory not available
    """
    if not MEMORY_AVAILABLE or not MEMORY_ID:
        return None
    
    try:
        # Sanitize session_id - AgentCore Memory only allows [a-zA-Z0-9][a-zA-Z0-9-_]*
        # Replace # with - to make channel#user format valid
        safe_session_id = session_id.replace('#', '-').replace(' ', '-')
        
        # Configure retrieval for all namespaces
        config = AgentCoreMemoryConfig(
            memory_id=MEMORY_ID,
            session_id=safe_session_id,
            actor_id=user_id,
            retrieval_config={
                # User preferences from fix: corrections
                '/preferences/{actorId}': RetrievalConfig(
                    top_k=5,
                    relevance_score=0.7,
                ),
                # Learned patterns, cached knowledge, AND synced item metadata
                # Higher top_k to ensure relevant items are found for linking
                '/patterns/{actorId}': RetrievalConfig(
                    top_k=50,
                    relevance_score=0.3,
                ),
            },
        )
        
        return AgentCoreMemorySessionManager(
            agentcore_memory_config=config,
            region_name=AWS_REGION,
        )
    except Exception as e:
        # Log but don't fail - Memory is optional
        print(f"Warning: Failed to create Memory session manager: {e}")
        return None


def search_memory_for_items(user_id: str, message: str) -> list:
    """
    Search Memory for items relevant to the user's message.
    
    Uses Memory's semantic search to find items that match the user's message.
    This enables more accurate linking by finding semantically similar items.
    
    Items are stored in /items/{actor_id} namespace using batch_create_memory_records.
    
    For project status queries (health, status, "my projects"), we use a broader
    search to ensure all projects are returned regardless of semantic relevance.
    
    Args:
        user_id: Slack user_id mapped to actor_id
        message: User's message to search for relevant items
    
    Returns:
        List of ItemMetadata objects matching the user's message
    
    Validates: Requirements 4.1, 4.2
    """
    if not MEMORY_AVAILABLE or not MEMORY_ID:
        return []
    
    try:
        from bedrock_agentcore.memory import MemoryClient
        
        client = MemoryClient(region_name=AWS_REGION)
        
        # Detect if this is a query that needs ALL items (not just semantic matches)
        message_lower = message.lower()
        is_list_all_query = any(term in message_lower for term in [
            'list all', 'show all', 'all my', 'what ideas', 'which ideas', 
            'my ideas', 'what decisions', 'which decisions', 'my decisions',
            'all projects', 'my projects', 'what projects', 'which projects',
            'when did i', 'when was'  # Date queries need full item context
        ])
        
        is_broad_query = is_list_all_query or any(term in message_lower for term in [
            'status', 'health', 'on hold', 'on-hold',
            'active', 'complete', 'cancelled', 'priorities', 'priority',
            'report', 'overview', 'summary'
        ])
        
        namespace = f'/items/{user_id}'
        
        # For "list all" queries, use list_memory_records to get ALL items
        # For other broad queries, use semantic search with generic terms
        if is_list_all_query:
            print(f"Debug: Using list_memory_records for list-all query")
            response = client.gmdp_client.list_memory_records(
                memoryId=MEMORY_ID,
                namespace=namespace,
                maxResults=100,
            )
            
            if not response:
                return []
            
            items = []
            summaries = response.get('memoryRecordSummaries', [])
            print(f"Debug: list_memory_records returned {len(summaries)} records")
            
            for record in summaries:
                content = record.get('content', {})
                if isinstance(content, dict):
                    content = content.get('text', '')
                
                if 'Last synced commit:' in content:
                    continue
                
                metadata = _parse_memory_item_to_metadata(content)
                if metadata:
                    items.append(metadata)
            
            return items
        
        # For other queries, use semantic search
        search_query = "project idea decision status" if is_broad_query else message
        
        print(f"Debug: search_memory_for_items - is_broad_query={is_broad_query}, search_query={search_query[:50]}")
        
        print(f"Debug: Calling retrieve_memories with memory_id={MEMORY_ID}, namespace={namespace}")
        
        response = client.retrieve_memories(
            memory_id=MEMORY_ID,
            namespace=namespace,
            query=search_query,
            actor_id=user_id,
            top_k=50,  # Get up to 50 relevant items
        )
        
        print(f"Debug: retrieve_memories returned {len(response) if response else 0} items")
        
        if not response:
            return []
        
        items = []
        # Response is a list of memory records
        for memory in response:
            content = memory.get('content', '')
            
            # Handle dict content format from retrieve_memories API
            # Content is returned as {'text': '...'} not a plain string
            if isinstance(content, dict):
                content = content.get('text', '')
            
            # Skip sync markers and other non-item content
            if 'Last synced commit:' in content:
                continue
            
            # Parse item metadata from Memory record text format
            metadata = _parse_memory_item_to_metadata(content)
            if metadata:
                items.append(metadata)
        
        return items
        
    except Exception as e:
        print(f"Warning: Memory search failed: {e}")
        return []


def _parse_memory_item_to_metadata(content: str):
    """
    Parse ItemMetadata from Memory event text format.
    
    Args:
        content: Memory event content in the format produced by ItemMetadata.to_memory_text()
    
    Returns:
        ItemMetadata or None if parsing fails
    """
    import re
    
    try:
        # Skip sync markers and other non-item content
        if 'Last synced commit:' in content:
            return None
        
        # Parse the stored format
        lines = content.strip().split('\n')
        
        title = None
        sb_id = None
        item_type = None
        path = None
        tags = []
        status = None
        created_at = None
        
        for line in lines:
            if line.startswith('Item: '):
                title = line[6:].strip()
            elif line.startswith('ID: '):
                sb_id = line[4:].strip()
            elif line.startswith('Type: '):
                item_type = line[6:].strip()
            elif line.startswith('Path: '):
                path = line[6:].strip()
            elif line.startswith('Tags: '):
                tags_str = line[6:].strip()
                tags = [t.strip() for t in tags_str.split(',') if t.strip()]
            elif line.startswith('Status: '):
                status = line[8:].strip()
            elif line.startswith('Created: '):
                created_at = line[9:].strip()
        
        # Validate required fields
        if not all([title, sb_id, item_type, path]):
            return None
        
        # Validate sb_id format
        if not re.match(r'^sb-[a-f0-9]{7}$', sb_id):
            return None
        
        # Create a simple object with the metadata attributes
        # We use a simple class to avoid circular import with item_sync
        class ParsedItemMetadata:
            def __init__(self, sb_id, title, item_type, path, tags, status, created_at=None):
                self.sb_id = sb_id
                self.title = title
                self.item_type = item_type
                self.path = path
                self.tags = tags
                self.status = status
                self.created_at = created_at
        
        return ParsedItemMetadata(
            sb_id=sb_id,
            title=title,
            item_type=item_type,
            path=path,
            tags=tags,
            status=status,
            created_at=created_at,
        )
        
    except Exception as e:
        print(f"Warning: Failed to parse memory item: {e}")
        return None


def read_items_from_codecommit() -> list:
    """
    Read all items directly from CodeCommit.
    
    This is the fallback method when Memory is unavailable.
    
    Returns:
        List of ItemMetadata objects from CodeCommit
    
    Validates: Requirements 4.3
    """
    if not ITEM_SYNC_AVAILABLE:
        return []
    
    try:
        sync_module = ItemSyncModule(memory_id=MEMORY_ID or '', region=AWS_REGION)
        head_commit = sync_module.get_codecommit_head()
        if not head_commit:
            return []
        
        all_files = sync_module._get_all_item_files(head_commit)
        items = []
        for file_info in all_files:
            content = sync_module.get_file_content(file_info['path'], head_commit)
            if content:
                metadata = sync_module.extract_item_metadata(file_info['path'], content)
                if metadata:
                    items.append(metadata)
        
        return items
        
    except Exception as e:
        print(f"Warning: CodeCommit read failed: {e}")
        return []


def get_item_context(user_id: str, message: str) -> list:
    """
    Get item context for classification.
    
    Primary: AgentCore Memory (fast, cached)
    Fallback: CodeCommit direct read (slower, always fresh)
    
    Memory-first approach reduces latency since items are already synced
    to Memory via batch_create_memory_records after each commit.
    
    Args:
        user_id: Slack user_id mapped to actor_id
        message: User's message to find relevant items for
    
    Returns:
        List of relevant items for the LLM context
    
    Validates: Requirements 4.1, 4.2, 4.3
    """
    # Try Memory first (faster, ~100-200ms)
    if MEMORY_AVAILABLE and MEMORY_ID:
        try:
            items = search_memory_for_items(user_id, message)
            if items:
                print(f"Info: Retrieved {len(items)} items from Memory (fast path)")
                return items
            else:
                print("Info: No items in Memory, falling back to CodeCommit")
        except Exception as e:
            print(f"Warning: Memory retrieval failed, falling back to CodeCommit: {e}")
    
    # Fallback to CodeCommit (slower, ~200-500ms, but always fresh)
    try:
        items = read_items_from_codecommit()
        if items:
            print(f"Info: Retrieved {len(items)} items from CodeCommit (fallback)")
        else:
            print("Warning: No items found in CodeCommit")
        return items
    except Exception as e:
        print(f"Warning: CodeCommit read failed: {e}")
        return []


def create_classifier_agent(system_prompt: str, session_manager=None) -> Agent:
    """
    Create a classifier agent with the provided system prompt.
    
    The agent has access to:
    - Memory: For item context (projects, ideas, decisions) and behavioral learning
    
    Note: use_aws tool has been removed. Item context is now provided via
    Memory, which is synced programmatically before classification.
    
    For Nova 2 models (nova-2-lite, nova-2-omni), extended thinking can be
    enabled via REASONING_EFFORT env var (disabled, low, medium, high).
    
    Args:
        system_prompt: The system prompt defining agent behavior
        session_manager: Optional AgentCoreMemorySessionManager for behavioral learning
    
    Returns:
        Configured Strands Agent
    """
    # Build model kwargs
    model_kwargs = {
        'model_id': MODEL_ID,
        'region_name': AWS_REGION,
        'max_tokens': 4096,  # Ensure enough tokens for complete Action Plan JSON
    }
    
    # Add Nova 2 reasoning config if applicable
    if is_nova_2_model(MODEL_ID) and REASONING_EFFORT != 'disabled':
        print(f"Info: Nova 2 extended thinking enabled with effort: {REASONING_EFFORT}")
        model_kwargs['additional_request_fields'] = {
            'reasoningConfig': {
                'type': 'enabled',
                'maxReasoningEffort': REASONING_EFFORT,  # low, medium, high
            }
        }
    
    # Configure Bedrock model with parameterized model ID
    model = BedrockModel(**model_kwargs)
    
    agent_kwargs = {
        'model': model,
        'system_prompt': system_prompt,
        'name': 'SecondBrainClassifier',
    }
    
    # Add session manager if Memory is available (Task 25.1)
    if session_manager:
        agent_kwargs['session_manager'] = session_manager
    
    return Agent(**agent_kwargs)


def validate_action_plan(plan: dict) -> list[str]:
    """Validate Action Plan / Filing Plan structure and return list of errors.
    
    Supports both the legacy Action Plan format (classification-based) and
    the new Filing Plan format (intent + file_path based).
    """
    errors = []
    
    # Check intent - defaults to 'capture' for backward compatibility
    intent = plan.get('intent', 'capture')
    valid_intents = ['capture', 'query', 'status_update', 'discuss']
    if intent not in valid_intents:
        errors.append(f"Invalid intent: {intent}. Must be one of: {valid_intents}")
    
    # Validate intent_confidence if present
    if 'intent_confidence' in plan:
        try:
            intent_conf = float(plan['intent_confidence'])
            if intent_conf < 0.0 or intent_conf > 1.0:
                errors.append(f"Intent confidence out of range [0, 1]: {intent_conf}")
        except (TypeError, ValueError):
            errors.append(f"Invalid intent_confidence value: {plan['intent_confidence']}")
    
    # For discuss intent, only require discuss_response
    if intent == 'discuss':
        if not plan.get('discuss_response'):
            errors.append("discuss_response is required for discuss intent")
        return errors
    
    # For query intent, different validation rules apply
    if intent == 'query':
        if plan.get('file_operations') and len(plan.get('file_operations', [])) > 0:
            errors.append("Query intent must not have file_operations")
        return errors
    
    # For status_update intent, validate status update fields
    if intent == 'status_update':
        status_update = plan.get('status_update')
        if not status_update or not isinstance(status_update, dict):
            errors.append("status_update object is required for status_update intent")
        else:
            if not status_update.get('project_reference'):
                errors.append("status_update.project_reference is required")
            target_status = status_update.get('target_status')
            valid_statuses = ['active', 'on-hold', 'complete', 'cancelled']
            if not target_status or target_status not in valid_statuses:
                errors.append(f"status_update.target_status must be one of: {valid_statuses}")
        return errors
    
    # For capture intent — support both Filing Plan (file_path) and legacy (classification)
    if 'file_path' in plan:
        # New Filing Plan format
        required_fields = ['file_path', 'action', 'title', 'content', 'reasoning']
        for field in required_fields:
            if field not in plan or not plan[field]:
                errors.append(f"Missing required field: {field}")
        
        valid_actions = ['create', 'append', 'update', 'delete', 'move']
        if 'action' in plan and plan['action'] not in valid_actions:
            errors.append(f"Invalid action: {plan['action']}. Must be one of: {valid_actions}")
        
        if plan.get('action') == 'move' and not plan.get('destination_path'):
            errors.append("destination_path is required for move action")
        
        if plan.get('action') == 'update' and not plan.get('section_target'):
            errors.append("section_target is required for update action")
    else:
        # Legacy Action Plan format (classification-based)
        classification = plan.get('classification', '')
        if classification == 'task':
            required_fields = ['classification', 'confidence', 'reasoning', 'title']
        else:
            required_fields = ['classification', 'confidence', 'reasoning', 'title', 'content']
        for field in required_fields:
            if field not in plan:
                errors.append(f"Missing required field: {field}")
        
        valid_classifications = ['inbox', 'idea', 'decision', 'project', 'task', 'fix']
        if 'classification' in plan and plan['classification'] not in valid_classifications:
            errors.append(f"Invalid classification: {plan['classification']}")
    
    # Confidence validation (works for both formats)
    confidence_field = 'confidence' if 'confidence' in plan else 'intent_confidence'
    if confidence_field in plan:
        try:
            confidence = float(plan[confidence_field])
            if confidence < 0.0 or confidence > 1.0:
                errors.append(f"Confidence out of range [0, 1]: {confidence}")
        except (TypeError, ValueError):
            errors.append(f"Invalid confidence value: {plan[confidence_field]}")
    
    return errors


def validate_front_matter(content: str, expected_type: str) -> list[str]:
    """
    Validate YAML front matter in markdown content.
    
    Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5
    
    Args:
        content: Markdown content that should contain front matter
        expected_type: Expected type field value (idea, decision, project)
    
    Returns:
        List of validation errors (empty if valid)
    """
    import re
    errors = []
    
    # Check if content starts with front matter
    if not content.startswith('---\n'):
        errors.append("Content must start with YAML front matter (---)")
        return errors
    
    # Find the closing ---
    end_match = re.search(r'\n---\n', content[4:])
    if not end_match:
        errors.append("Front matter must have closing delimiter (---)")
        return errors
    
    yaml_block = content[4:4 + end_match.start()]
    
    # Parse front matter fields
    fields = {}
    for line in yaml_block.split('\n'):
        match = re.match(r'^(\w+):\s*(.*)$', line)
        if match:
            fields[match.group(1)] = match.group(2).strip()
    
    # Requirement 9.1: Validate id matches SB_ID format
    if 'id' not in fields:
        errors.append("Front matter missing required field: id")
    else:
        sb_id = fields['id']
        if not re.match(r'^sb-[a-f0-9]{7}$', sb_id):
            errors.append(f"Invalid SB_ID format: {sb_id}. Must match sb-[a-f0-9]{{7}}")
    
    # Requirement 9.2: Validate type matches classification
    if 'type' not in fields:
        errors.append("Front matter missing required field: type")
    elif fields['type'] != expected_type:
        errors.append(f"Front matter type '{fields['type']}' does not match classification '{expected_type}'")
    
    # Requirement 9.3: Validate created_at is valid ISO-8601
    if 'created_at' not in fields:
        errors.append("Front matter missing required field: created_at")
    else:
        created_at = fields['created_at']
        # Basic ISO-8601 validation
        iso_pattern = r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$'
        if not re.match(iso_pattern, created_at):
            errors.append(f"Invalid created_at format: {created_at}. Must be ISO-8601")
    
    # Requirement 9.4: Validate tags is present (array validation is complex in YAML)
    if 'tags' not in fields and 'tags:' not in yaml_block:
        errors.append("Front matter missing required field: tags")
    
    # Validate title is present
    if 'title' not in fields:
        errors.append("Front matter missing required field: title")
    
    return errors


def normalize_response(result: dict | list) -> dict | None:
    """
    Normalize the parsed JSON response.
    
    Handles:
    - Single Action Plan dict -> return as-is
    - Multi-item response with 'items' array -> return as-is
    - Raw list of Action Plans -> wrap in { "items": [...] }
    
    Validates: Requirements 2.1, 2.5
    """
    if isinstance(result, dict):
        # Check if it's a multi-item response wrapper
        if 'items' in result and isinstance(result['items'], list):
            items = result['items']
            if len(items) == 0:
                return None
            if len(items) == 1:
                # Single item wrapped in items array - unwrap it
                return items[0] if isinstance(items[0], dict) else None
            # Multiple items - return as-is
            return result
        # Single Action Plan
        return result
    
    if isinstance(result, list):
        if len(result) == 0:
            return None
        if len(result) == 1:
            # Single item in list - unwrap
            return result[0] if isinstance(result[0], dict) else None
        # Multiple items - wrap in multi-item format
        return {"items": result}
    
    return None


def validate_multi_item_response(response: dict) -> tuple[bool, list[str]]:
    """
    Validate a multi-item response structure.
    
    Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5
    
    Returns (is_valid, errors)
    """
    errors = []
    
    if 'items' not in response:
        return False, ["Missing 'items' field"]
    
    items = response['items']
    if not isinstance(items, list):
        return False, ["'items' must be an array"]
    
    if len(items) < 2:
        return False, ["'items' array must contain at least 2 items"]
    
    for i, item in enumerate(items):
        item_errors = validate_action_plan(item)
        for error in item_errors:
            errors.append(f"items[{i}]: {error}")
    
    return len(errors) == 0, errors


def is_multi_item_response(response: dict) -> bool:
    """Check if response is a multi-item format."""
    return (
        isinstance(response, dict) and 
        'items' in response and 
        isinstance(response['items'], list) and 
        len(response['items']) >= 2
    )


def extract_json_from_response(response_text: str) -> dict | None:
    """
    Extract JSON from LLM response, handling markdown code blocks.
    
    Returns either:
    - A single Action Plan dict (single item)
    - A dict with 'items' array (multi-item response)
    - None if parsing fails
    
    Validates: Requirements 2.1, 2.5
    """
    import re
    
    # Look for ```json ... ``` blocks
    json_match = re.search(r'```(?:json)?\s*\n?(.*?)\n?```', response_text, re.DOTALL)
    if json_match:
        try:
            result = json.loads(json_match.group(1).strip())
            return normalize_response(result)
        except json.JSONDecodeError:
            pass
    
    # Try to parse the entire response as JSON
    try:
        result = json.loads(response_text.strip())
        return normalize_response(result)
    except json.JSONDecodeError:
        pass
    
    # Try to find any JSON object in the response
    json_match = re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', response_text, re.DOTALL)
    if json_match:
        try:
            return json.loads(json_match.group(0))
        except json.JSONDecodeError:
            pass
    
    return None


@app.entrypoint
async def invoke(payload=None):
    """
    Main entrypoint for the classifier agent.
    
    Expected payload for classification:
    {
        "prompt": "User message to classify",
        "system_prompt": "System prompt content",
        "session_id": "optional session identifier",
        "user_id": "Slack user_id for Memory actor_id"
    }
    
    Expected payload for sync operations:
    {
        "sync_operation": "health_check" | "sync_item" | "sync_all" | "delete_item",
        "actor_id": str,
        ... operation-specific fields
    }
    
    Returns Action Plan JSON (single or multi-item format) for classification,
    or sync result for sync operations.
    
    Validates: Requirements 2.1, 2.2, 2.3, 2.4
    """
    try:
        if not payload:
            return {
                "status": "error",
                "error": "No payload provided"
            }
        
        # Route sync operations to dedicated handler
        if payload.get("sync_operation"):
            return handle_sync_operation(payload)
        
        user_message = payload.get("prompt", "")
        system_prompt = payload.get("system_prompt", "")
        session_id = payload.get("session_id", "default")
        user_id = payload.get("user_id", "anonymous")  # Task 25.1: Map to actor_id
        
        if not user_message:
            return {
                "status": "error",
                "error": "No prompt provided in payload"
            }
        
        if not system_prompt:
            # Use minimal fallback prompt
            system_prompt = """You are a message classifier. Classify the message and return a JSON Action Plan with:
            - classification: one of inbox, idea, decision, project, task
            - confidence: 0.0 to 1.0
            - reasoning: brief explanation
            - title: short title
            - content: formatted content
            - file_operations: array of file operations
            Return only valid JSON."""
        
        # Note: Items are synced to Memory immediately after each commit via worker
        # No need for pre-classification sync - Memory should already be up to date
        
        # Fetch item context using Memory-first retrieval with CodeCommit fallback
        # Validates: Requirements 4.1, 4.2, 4.3
        item_context = ""
        if ITEM_SYNC_AVAILABLE:
            try:
                items = get_item_context(user_id, user_message)
                
                if items:
                    # Build context section for system prompt
                    context_lines = ["\n\n## Item Context from Knowledge Base\n"]
                    context_lines.append("Use these items for linking when relevant:\n")
                    for item in items:
                        status_str = f" (status: {item.status})" if item.status else ""
                        tags_str = f" [tags: {', '.join(item.tags)}]" if item.tags else ""
                        created_str = f" (created: {item.created_at})" if getattr(item, 'created_at', None) else ""
                        context_lines.append(f"- {item.item_type}: \"{item.title}\" (sb_id: {item.sb_id}){created_str}{status_str}{tags_str}")
                    item_context = "\n".join(context_lines)
                    print(f"Info: Injected {len(items)} items into context")
                    # Debug: Print the actual items being injected
                    print(f"Debug: Item context:\n{item_context}")
                else:
                    print("Warning: No items found in Memory or CodeCommit")
            except Exception as e:
                # Log but don't fail - context injection is optional
                print(f"Warning: Item context injection failed: {e}")
        
        # Append item context to system prompt
        enhanced_prompt = system_prompt + item_context
        
        # Task 25.1: Create session manager for Memory integration (for behavioral learning)
        session_manager = create_session_manager(user_id, session_id)
        
        # Create agent with enhanced system prompt and optional Memory
        agent = create_classifier_agent(enhanced_prompt, session_manager)
        
        # Invoke agent
        response = agent(user_message)
        response_text = response.message['content'][0]['text']
        
        # Debug: Log the raw LLM response for query intents
        print(f"Debug: Raw LLM response (first 1000 chars):\n{response_text[:1000]}")
        
        # Extract JSON from response (handles both single and multi-item)
        action_plan = extract_json_from_response(response_text)
        
        if not action_plan:
            return {
                "status": "error",
                "error": "Failed to extract valid JSON from agent response",
                "raw_response": response_text[:500]  # Truncate for logging
            }
        
        # Check if this is a multi-item response
        if is_multi_item_response(action_plan):
            # Validate multi-item response
            is_valid, validation_errors = validate_multi_item_response(action_plan)
            
            if not is_valid:
                return {
                    "status": "error",
                    "error": "Multi-item response validation failed",
                    "validation_errors": validation_errors,
                    "action_plan": action_plan
                }
            
            # Include memory status in response
            memory_enabled = session_manager is not None
            
            # Note: Items are synced to Memory immediately after commit via worker
            # No need for post-classification sync here
            
            return {
                "status": "success",
                "action_plan": action_plan,  # Returns { "items": [...] }
                "memory_enabled": memory_enabled,
                "multi_item": True,
                "item_count": len(action_plan['items']),
            }
        
        # Single item - validate as before
        validation_errors = validate_action_plan(action_plan)
        
        if validation_errors:
            return {
                "status": "error",
                "error": "Action Plan validation failed",
                "validation_errors": validation_errors,
                "action_plan": action_plan
            }
        
        # Include memory status in response
        memory_enabled = session_manager is not None
        
        # Explicitly save conversation to Memory for learning
        # The Strands session_manager doesn't auto-save single-turn invocations
        if MEMORY_AVAILABLE and MEMORY_ID:
            try:
                from bedrock_agentcore.memory import MemoryClient
                safe_session_id = session_id.replace('#', '-').replace(' ', '-')
                
                # Create a summary of what was classified
                classification = action_plan.get('classification', 'unknown')
                title = action_plan.get('title', '')
                summary = f"Classified as {classification}: {title}"
                
                client = MemoryClient(region_name=AWS_REGION)
                client.save_turn(
                    memory_id=MEMORY_ID,
                    actor_id=user_id,
                    session_id=safe_session_id,
                    user_input=user_message,
                    agent_response=summary
                )
            except Exception as e:
                # Log but don't fail - Memory is optional
                print(f"Warning: Failed to save to Memory: {e}")
        
        # Note: Items are synced to Memory immediately after commit via worker
        # No need for post-classification sync here
        
        return {
            "status": "success",
            "action_plan": action_plan,
            "memory_enabled": memory_enabled,
        }
        
    except Exception as e:
        return {
            "status": "error",
            "error": str(e)
        }


def record_fix_preference(user_id: str, original_classification: str, corrected_classification: str, context: str):
    """
    Task 31.3: Record a fix command as a learned preference.
    
    When a user corrects a classification via fix: command, we store this
    as a preference so the agent can learn from it.
    
    Args:
        user_id: Slack user_id (actor_id)
        original_classification: What the agent originally classified as
        corrected_classification: What the user corrected it to
        context: Brief context about the message (for pattern matching)
    """
    if not MEMORY_AVAILABLE or not MEMORY_ID:
        return
    
    try:
        client = MemoryClient(region_name=AWS_REGION)
        
        # Store the correction as a preference
        # The Memory strategies will extract and consolidate this over time
        preference_text = (
            f"User prefers '{corrected_classification}' over '{original_classification}' "
            f"for messages like: {context[:100]}"
        )
        
        # This will be processed by userPreferenceMemoryStrategy
        # and stored in /preferences/{actorId} namespace
        client.create_event(
            memory_id=MEMORY_ID,
            actor_id=user_id,
            session_id=f"fix-{user_id}",
            event_type="preference_correction",
            content=preference_text,
        )
    except Exception as e:
        # Log but don't fail - preference learning is optional
        print(f"Warning: Failed to record fix preference: {e}")


# ============================================================================
# Sync Operations (moved from sync Lambda)
# ============================================================================

def ensure_memory_initialized(actor_id: str) -> bool:
    """
    Sync items from CodeCommit to Memory before classification.
    
    Always performs a full sync since item count is small (<100 items).
    This ensures Memory has the latest items for semantic search.
    
    Args:
        actor_id: User/actor ID for scoped storage
        
    Returns:
        True if sync succeeded, False on error
    """
    if not ITEM_SYNC_AVAILABLE or not MEMORY_ID:
        return False
    
    try:
        sync_module = ItemSyncModule(memory_id=MEMORY_ID, region=AWS_REGION)
        
        # Always sync to ensure Memory is up to date
        result = sync_module.sync_items(actor_id)
        
        if result.success:
            print(f"Info: Memory sync completed ({result.items_synced} items)")
            return True
        else:
            print(f"Warning: Memory sync failed: {result.error}")
            return False
            
    except Exception as e:
        print(f"Warning: Failed to sync memory: {e}")
        return False


def run_delta_sync(actor_id: str) -> None:
    """
    Sync items to Memory after classification completes.
    
    This keeps Memory up-to-date with any changes made during classification.
    Called after the response is sent to minimize latency impact.
    
    Args:
        actor_id: User/actor ID for scoped storage
    """
    if not ITEM_SYNC_AVAILABLE or not MEMORY_ID:
        return
    
    try:
        sync_module = ItemSyncModule(memory_id=MEMORY_ID, region=AWS_REGION)
        result = sync_module.sync_items(actor_id)
        
        if result.success:
            print(f"Info: Post-classification sync completed ({result.items_synced} items)")
        else:
            print(f"Warning: Post-classification sync failed: {result.error}")
            
    except Exception as e:
        print(f"Warning: Post-classification sync error: {e}")


def handle_sync_operation(payload: dict) -> dict:
    """
    Handle sync operations (health_check, sync_item, sync_all, delete_item).
    
    This replaces the separate sync Lambda - the classifier already has
    bedrock_agentcore installed, so it can handle Memory operations directly.
    
    Args:
        payload: {
            "sync_operation": "health_check" | "sync_item" | "sync_all" | "delete_item",
            "actor_id": str,
            "item_path": str (for sync_item),
            "item_content": str (for sync_item),
            "sb_id": str (for delete_item),
            "force_full_sync": bool (for sync_all)
        }
    
    Returns:
        {
            "success": bool,
            "items_synced": int,
            "items_deleted": int,
            "error": str | None,
            "health_report": dict | None
        }
    """
    if not ITEM_SYNC_AVAILABLE:
        return {
            "success": False,
            "items_synced": 0,
            "items_deleted": 0,
            "error": "ItemSyncModule not available",
            "health_report": None,
        }
    
    operation = payload.get('sync_operation')
    actor_id = payload.get('actor_id', 'anonymous')
    
    if not operation:
        return {
            "success": False,
            "items_synced": 0,
            "items_deleted": 0,
            "error": "Missing sync_operation field",
            "health_report": None,
        }
    
    # Initialize sync module
    sync_module = ItemSyncModule(memory_id=MEMORY_ID, region=AWS_REGION)
    
    if operation == 'health_check':
        return _handle_health_check(sync_module, actor_id)
    elif operation == 'sync_item':
        return _handle_sync_item(sync_module, actor_id, payload)
    elif operation == 'sync_all':
        return _handle_sync_all(sync_module, actor_id, payload)
    elif operation == 'delete_item':
        return _handle_delete_item(sync_module, actor_id, payload)
    elif operation == 'repair':
        return _handle_repair(sync_module, actor_id, payload)
    else:
        return {
            "success": False,
            "items_synced": 0,
            "items_deleted": 0,
            "error": f"Unknown sync_operation: {operation}",
            "health_report": None,
        }


def _handle_health_check(sync_module, actor_id: str) -> dict:
    """Handle health check operation."""
    try:
        health_report = sync_module.get_health_report(actor_id)
        return {
            "success": True,
            "items_synced": 0,
            "items_deleted": 0,
            "error": None,
            "health_report": {
                "codecommitCount": health_report.codecommit_count,
                "memoryCount": health_report.memory_count,
                "inSync": health_report.in_sync,
                "lastSyncTimestamp": health_report.last_sync_timestamp,
                "lastSyncCommitId": health_report.last_sync_commit_id,
                "missingInMemory": health_report.missing_in_memory,
                "extraInMemory": health_report.extra_in_memory,
            },
        }
    except Exception as e:
        print(f"Error during health check: {e}")
        return {
            "success": False,
            "items_synced": 0,
            "items_deleted": 0,
            "error": f"Health check failed: {str(e)}",
            "health_report": None,
        }


def _handle_sync_item(sync_module, actor_id: str, payload: dict) -> dict:
    """Handle single item sync operation."""
    item_path = payload.get('item_path')
    item_content = payload.get('item_content')
    commit_id = payload.get('commit_id')  # Optional: update marker after sync
    
    if not item_path or not item_content:
        return {
            "success": False,
            "items_synced": 0,
            "items_deleted": 0,
            "error": "Missing item_path or item_content",
            "health_report": None,
        }
    
    try:
        result = sync_module.sync_single_item(actor_id, item_path, item_content, commit_id)
        return {
            "success": result.success,
            "items_synced": result.items_synced,
            "items_deleted": result.items_deleted,
            "error": result.error,
            "health_report": None,
        }
    except Exception as e:
        print(f"Error syncing item: {e}")
        return {
            "success": False,
            "items_synced": 0,
            "items_deleted": 0,
            "error": f"Sync item failed: {str(e)}",
            "health_report": None,
        }


def _handle_sync_all(sync_module, actor_id: str, payload: dict) -> dict:
    """Handle full sync operation."""
    try:
        # Check if force full sync requested (rebuild)
        force_full_sync = payload.get('force_full_sync', False)
        if force_full_sync:
            # Clear all existing memory records first to avoid duplicates
            print("Force full sync: clearing existing memory records...")
            deleted_count = sync_module.clear_all_memory_records(actor_id)
            print(f"Force full sync: cleared {deleted_count} records")
            
            # Reset sync marker to force full sync
            sync_module.set_sync_marker('initial')
            print("Force full sync: reset sync marker to 'initial'")
        
        result = sync_module.sync_items(actor_id)
        return {
            "success": result.success,
            "items_synced": result.items_synced,
            "items_deleted": result.items_deleted,
            "error": result.error,
            "health_report": None,
        }
    except Exception as e:
        print(f"Error during full sync: {e}")
        return {
            "success": False,
            "items_synced": 0,
            "items_deleted": 0,
            "error": f"Full sync failed: {str(e)}",
            "health_report": None,
        }


def _handle_delete_item(sync_module, actor_id: str, payload: dict) -> dict:
    """Handle item deletion operation."""
    sb_id = payload.get('sb_id')
    
    if not sb_id:
        return {
            "success": False,
            "items_synced": 0,
            "items_deleted": 0,
            "error": "Missing sb_id",
            "health_report": None,
        }
    
    try:
        success = sync_module.delete_item_from_memory(actor_id, sb_id)
        return {
            "success": success,
            "items_synced": 0,
            "items_deleted": 1 if success else 0,
            "error": None,
            "health_report": None,
        }
    except Exception as e:
        print(f"Error deleting item: {e}")
        return {
            "success": False,
            "items_synced": 0,
            "items_deleted": 0,
            "error": f"Delete item failed: {str(e)}",
            "health_report": None,
        }


def _handle_repair(sync_module, actor_id: str, payload: dict) -> dict:
    """
    Handle repair operation - sync only missing items.
    
    This avoids creating duplicates by only syncing items that are
    missing from Memory (identified by sb_id).
    """
    missing_ids = payload.get('missing_ids', [])
    
    if not missing_ids:
        return {
            "success": True,
            "items_synced": 0,
            "items_deleted": 0,
            "error": None,
            "health_report": None,
        }
    
    try:
        # Get current HEAD commit
        head_commit = sync_module.get_codecommit_head()
        if not head_commit:
            return {
                "success": False,
                "items_synced": 0,
                "items_deleted": 0,
                "error": "Failed to get CodeCommit HEAD",
                "health_report": None,
            }
        
        # Get all item files and extract their metadata
        all_files = sync_module._get_all_item_files(head_commit)
        
        # Build a map of sb_id -> metadata for all items
        items_by_id = {}
        for file_info in all_files:
            path = file_info['path']
            content = sync_module.get_file_content(path, head_commit)
            if content:
                metadata = sync_module.extract_item_metadata(path, content)
                if metadata:
                    items_by_id[metadata.sb_id] = metadata
        
        # Sync only the missing items
        items_synced = 0
        for missing_id in missing_ids:
            if missing_id in items_by_id:
                metadata = items_by_id[missing_id]
                if sync_module.store_item_in_memory(actor_id, metadata):
                    items_synced += 1
                    print(f"Repaired: {missing_id}")
                else:
                    print(f"Failed to repair: {missing_id}")
            else:
                print(f"Item not found in CodeCommit: {missing_id}")
        
        return {
            "success": True,
            "items_synced": items_synced,
            "items_deleted": 0,
            "error": None,
            "health_report": None,
        }
    except Exception as e:
        print(f"Error during repair: {e}")
        return {
            "success": False,
            "items_synced": 0,
            "items_deleted": 0,
            "error": f"Repair failed: {str(e)}",
            "health_report": None,
        }


if __name__ == "__main__":
    app.run()
