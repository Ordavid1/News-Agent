**INTERNAL CONTEXT PROVIDERS FOR FOCUSED DEVELOPMENT**
- Always follow development ground rules detailed in /Users/ordavid/Downloads/Saas-standalone/CLAUDE.md

**CONTEXT PROVIDERS FOR FOCUSED DEVELOPMENT:**
- Use **Claude Code Tasks** as primary context source for project exploration, file analysis, and code searches
- Use **context7 MCP** for official documentation and live examples  
- Use **memory MCP** for persistent project facts and architecture decisions
- Use **playwright MCP** for browser automation and debugging

**CLAUDE CODE TASK USAGE (PREFERRED):**
- Launch Tasks for file searches, code analysis, and project exploration
- Tasks have separate context windows - no main session pollution
- Full tool access: Read, Glob, Grep, Bash, all file operations
- No rate limiting or external dependencies
- Use when searching for keywords, understanding codebase, debugging

**SMART FILE ANALYSIS:**
- Use grep with context: `grep -A 15 -B 5 "search_term" filename`
- Function analysis: `grep -A 20 -B 2 "^(function|class|def|export)" filename`
- Error investigation: `grep -A 10 -B 10 "(error|Error|exception|Exception)" filename`

**CRITICAL PROJECT SETUP:**
- Activate virtual environment: `source venv/bin/activate`
- Configuration in .env file (single source of truth)
- If you create .md files always save them in /Users/ordavid/Downloads/ai-knowledge-center/docs

**PID DIRECTORY STRUCTURE:**
```
logs/pids/bridge_<SERVER_PID>/
├── server.log                    # Bridge server logs
├── server_info.txt               # Server metadata  
├── react_<REACT_PID>/           # React frontend directory
│   └── react.log                # Frontend logs
└── apps/                        # Gibraltar applications
    └── app_<APP_PID>/
        ├── app_info.txt         # App metadata
        └── app.log             # App logs
```

**DEBUGGING WORKFLOW:**
- Check status: `./gibraltar-cli --debug status`
- View PID directories: `ls -la logs/pids/`
- Check server logs: `cat logs/pids/bridge_<PID>/server.log`
- Check app logs: `cat logs/pids/bridge_<PID>/apps/app_<APP_PID>/app.log`

**BROWSER DEBUGGING:**
- Use `mcp__playwright__browser_*` functions for browser automation
- Monitor console logs and network requests for debugging

**FOR DEPLOYMENT PURPOSES**
- When performing deployment actions, always make sure you are using the correct google project id: "lucky-outpost-328619"