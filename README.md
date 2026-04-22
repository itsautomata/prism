# prism

**free, local-first AI coding assistant**

Prism is an open source coding assistant that runs locally on your machine. you give it a task, it reads your code, edits files, runs commands...
powered by Ollama. but not exclusively, other providers will be added soon.

> actively built and tested. expect breaking changes. decentralized intelligence is cool

![prism](assets/prism_1.png)

## quick start

requires Ollama v0.20.2+ for proper tool calling.

```bash
brew install ollama
ollama serve
ollama pull deepseek-r1:14b

cd prism
npm install
sudo ln -s $(pwd)/bin/prism /usr/local/bin/prism

prism
```

## choose your model

### local (free, ollama)

```bash
prism                       # deepseek-r1:14b (default)
prism qwen3:14b             # best balance
prism qwen2.5-coder:7b      # fast, light, good tool use
```

### cloud (openrouter, 200+ models)

add your API key to `~/.prism/config.toml` (created on first run), then:

```bash
prism --or                                    # qwen3-coder-480b (free, rate limited)
prism --or deepseek/deepseek-r1               # free, rate limited
prism --or google/gemini-2.0-flash            # $0.10/M tokens
prism --or deepseek/deepseek-v3.2             # $0.14/M tokens, best value
prism --or anthropic/claude-haiku-4.5         # $0.80/M tokens, best tool use
```

see [openrouter.ai/docs](https://openrouter.ai/docs) for all available models and rate limits.

### sessions

prism auto-saves your conversation after every turn. resume where you left off:

```bash
prism --continue                              # resume last session in this directory
prism -c                                      # same
prism --or deepseek/deepseek-r1 --continue    # resume with a different model
prism --sessions                              # list recent sessions
```

sessions saved at `~/.prism/sessions/`.

## tools

| tool | what it does |
|------|-------------|
| Bash | execute shell commands |
| Read | read files with line numbers |
| Edit | exact string replacement |
| Write | create or overwrite files |
| Glob | find files by pattern |
| Grep | search file contents |

## permissions

write operations ask before executing. read operations auto-allow.

```
◆ Bash wants to: run: git push
  ▸ [y] yes (once)
    [a] yes (always this session)
    [n] no
```

## teach it

prism learns per model. rules persist across sessions.

```
/teach never run git push without asking first
/rules
/forget 2
```

rules saved at `~/.prism/models/<model>.json`.

## lens.md

add a `lens.md` to any project to give prism custom instructions for that directory.

example:

```markdown
# lens.md
use pytest for testing.
never modify files in data/.
this project uses pydantic v2.
```

## commands

```
/teach <rule>     teach the model a rule
/rules            show learned rules
/forget <n>       remove a rule
/max-tools <n>    limit tools for this model
/clear            clear conversation
/help             show commands
/exit             quit
```

## note

different models have different strengths. tool calling, reasoning.. quality varies. some will outperform others while others will do very badly.
but I'm actively closing the gaps as best as possible. 
