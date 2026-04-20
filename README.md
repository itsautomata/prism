# prism

**local-first AI coding assistant**

> work in progress

## what it does

you give it a task. it decomposes it into actions, executes them through tools, and recomposes the results into one response. runs locally on Ollama, free.

## quick start

```bash
# install ollama
brew install ollama
ollama serve
ollama pull gemma4:e4b

# clone and run
cd prism
npm install
./bin/prism
```

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
/teach when I say "check", run the test suite
/rules
/forget 2
```

rules saved at `~/.prism/models/<model>.json`.

## task routing

prism classifies your input and adapts its behavior:

- **code**: read existing code first, use Edit, match style
- **reasoning**: think step by step, verify with tools
- **search**: use Grep and Glob, not Bash
- **conversation**: respond with text, no tools
- **simple**: one tool call, minimal output

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

## run from anywhere

```bash
# symlink (recommended)
sudo ln -s $(pwd)/bin/prism /usr/local/bin/prism

# then from any directory
prism
prism qwen2.5-coder:7b
prism gemma4:e4b
```
