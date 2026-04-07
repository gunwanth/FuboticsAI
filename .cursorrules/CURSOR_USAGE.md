# Using AI Agents with Cursor

## Setup Complete! ✓

Your AI agents are configured and ready to use.

## How to Use

### 1. @-Mentions (Primary Method)

The most powerful way to use agents in Cursor:

```
@.cursorrules/engineering/backend-architect.md

Design a REST API for user management with:
- Authentication
- CRUD operations
- Rate limiting
```

### 2. Multiple Agents

Combine multiple agents for complex tasks:

```
@.cursorrules/engineering/backend-architect.md
@.cursorrules/testing/api-tester.md

Design and test a payment processing API
```

### 3. In Composer

Use agents in Cursor's Composer mode for multi-file changes:

1. Open Composer (Cmd/Ctrl + I)
2. Add agent with @-mention
3. Describe your task
4. Cursor will apply changes across files

## Tips

- **Specific Agents**: Use the most relevant agent for your task
- **Combine Agents**: Multiple agents can collaborate on complex tasks
- **Context**: Agents have access to your codebase context
- **Iterations**: Refine results by providing feedback

## Agent Directory

Browse agents: `.cursorrules/`

## Troubleshooting

**Agents not appearing in @-mentions?**
- Ensure files are in `.cursorrules/` directory
- Restart Cursor
- Check Cursor settings for custom instruction paths

**Need different agents?**
Run: `agentkit init` to reconfigure

---

Happy coding with AI agents! 💜
