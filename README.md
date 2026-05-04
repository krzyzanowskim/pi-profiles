# pi-profiles

A small Pi package for running Pi with separate auth profiles such as `personal` and `work`.

## Is this possible?

Yes, but not as a pure in-process extension.

Pi creates its `AuthStorage` before extensions run. The CLI auth file is derived from the Pi agent directory:

- default: `~/.pi/agent/auth.json`
- override: `PI_CODING_AGENT_DIR=/some/dir`, which makes Pi use `/some/dir/auth.json`

The SDK can also use `AuthStorage.create("/custom/auth.json")`, but the stock CLI does not expose an `--auth-file` or `--profile` flag. So this package uses a launcher (`pi-profile`) to set `PI_CODING_AGENT_DIR` **before Pi starts**, then loads a tiny extension that shows which profile is active.

Trade-off: `PI_CODING_AGENT_DIR` separates the whole Pi agent directory, not only auth. This launcher makes sessions shared again by setting `PI_CODING_AGENT_SESSION_DIR` to Pi's standard session location (`~/.pi/agent/sessions`) by default.

## Install

With mise:

```bash
mise use -g npm:@krzyzanowskim/pi-profiles@latest
```

With npm:

```bash
npm install -g @krzyzanowskim/pi-profiles
```

Then run:

```bash
pi-profile personal
pi-profile work
```

### Local development install

From this directory:

```bash
npm link
```

Or without linking:

```bash
node ./bin/pi-profile.js personal
```

## Usage

```bash
# Start interactive Pi using ~/.pi/agent-profiles/personal/auth.json
pi-profile personal

# Start a work profile
pi-profile work

# Pass normal Pi flags through
pi-profile work --model claude-sonnet-4-5
pi-profile work -p "Summarize this repo"

# Show profile directories
pi-profile --list
pi-profile --dir work
```

## Shell shortcuts

For shorter commands, add shell functions to your `~/.zshrc`, `~/.bashrc`, or equivalent:

```bash
pi_work() {
    pi-profile work "$@"
}

pi_personal() {
    pi-profile personal "$@"
}
```

Then use them like the launcher:

```bash
pi_work
pi_work --model claude-sonnet-4-5
pi_personal -p "Summarize this repo"
```

You can also generate these functions:

```bash
# Generate functions for existing profile directories
pi-profile --shell >> ~/.zshrc

# Or name profiles explicitly
pi-profile --shell work personal >> ~/.zshrc
```

Inside Pi, run:

```text
/auth-profile
```

That reports the active profile, agent directory, auth file, and stored providers.

## Login flow

```bash
pi-profile work
/login
```

OAuth credentials are stored in:

```text
~/.pi/agent-profiles/work/auth.json
```

Repeat for `personal` or any other profile.

## Profile-specific API keys

By default the launcher clears common provider API-key environment variables so a global `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` does not silently bypass profile isolation.

For profile-specific environment variables, create:

```text
~/.pi/agent-profiles/work/env
```

Example:

```bash
ANTHROPIC_API_KEY=sk-ant-work-...
OPENAI_API_KEY=sk-work-...
```

If you intentionally want to keep the shell's auth environment, use:

```bash
pi-profile work --allow-env-auth
```

## Shared sessions

Sessions are shared automatically across profiles. The launcher sets:

```text
PI_CODING_AGENT_SESSION_DIR=~/.pi/agent/sessions
```

That is Pi's standard session location, so `pi-profile personal`, `pi-profile work`, and regular `pi` all see the same session list:

```bash
pi-profile personal
pi-profile work
```

Normal Pi `--session-dir <dir>` still works and takes precedence for that run, but you do not need it for profile sharing.

## Publishing

Package checks:

```bash
npm run check
npm pack --dry-run
```

Publish:

```bash
npm publish
```

## Notes

- The extension alone only displays and validates profile state. The launcher is what makes auth separation reliable.
- Auth/settings/models/resources are profile-specific. Sessions always use Pi's standard `~/.pi/agent/sessions` location by default.
- Since the whole agent dir changes, global extensions/settings from `~/.pi/agent` are not automatically loaded inside profiles. Install or configure the resources you want per profile, or pass them via normal Pi flags.
