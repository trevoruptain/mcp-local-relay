# Testing Prompts with Arguments

To properly test prompt argument interpolation, you need to pass values for the arguments when calling the prompt from Claude.

## Example Usage

```python
# Import the MCP client
from modelcontextprotocol.client import Client

# Create an MCP Client instance
client = Client()

# Find available prompts
prompts = client.list_prompts()
print(f"Available prompts: {prompts}")

# Call a prompt WITH ARGUMENTS
prompt_result = client.get_prompt(
    name="Vapi Campaign Creator",
    arguments={
        "campaign_type": "appointment_reminder",
        "target_audience": "existing customers"
    }
)

# Now the variables should be interpolated
print(prompt_result)
```

## Testing in Claude

When using prompts through Claude, you need to be explicit about passing arguments:

```
I want to use the "Vapi Campaign Creator" prompt with the following arguments:
- campaign_type: appointment_reminder
- target_audience: small business owners
```

If Claude doesn't recognize your instruction to pass arguments, try being more explicit:

```
Please execute the "Vapi Campaign Creator" prompt and pass these arguments:
{
  "campaign_type": "renewal_reminder",
  "target_audience": "enterprise customers"
}
```

## Debugging Tips

1. Check the local-relay-debug.log file for:

   - The arguments received by the promptHandler
   - The request being sent to the server
   - The response from the server

2. If arguments show as empty, Claude isn't passing them properly

3. If arguments are passed but not interpolated, check the server logs
