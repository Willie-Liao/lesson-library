---
hookEvent: PreToolUse
type: script
matcher: "Write|Edit|Bash"
priority: 10
---

```bash
python3 "__REPO__/scripts/library-mcp-only.py" --format claude
```
