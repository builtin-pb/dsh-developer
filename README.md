# dsh-developer

> **The single plugin you need for DSH**

Proudly designed and implemented by [MetaFlow](https://github.com/builtin-pb/metaflow), **dsh-developer** is an unofficial community plugin that fixes the dangerous last mile of DSH plugin development: a plugin can look finished in its checkout and still fail to register, load, survive the next DSH lane, or cross a release boundary safely.

One native workflow inspects the exact DSH installation, audits Creator exports and existing repositories, deterministically builds a new plugin bundle, and exercises trusted bytes across exact release and preview lanes. DSH agents get the same evidence through one structured model tool—not a shell transcript or a Web-only command. The workflow also admits scoped browser providers for semantic, compute-bounded UI verification while DSH policy contains their dangerous authority. It witnesses clean-profile install, load, discovery, and uninstall, classifies capability drift, and emits stable evidence before handoff. Caller-supplied repositories stay read-only and are not executed; generated bundles run only after their bytes reproduce from fingerprinted provenance.

[![CI](https://github.com/builtin-pb/dsh-developer/actions/workflows/ci.yml/badge.svg)](https://github.com/builtin-pb/dsh-developer/actions/workflows/ci.yml) [![Node.js 22.18+](https://img.shields.io/badge/Node.js-22.18%2B-339933?logo=nodedotjs&logoColor=white)](package.json) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

```text
Creator export  ->  Doctor  ->  deterministic bundle  ->  real DSH lifecycle proof
Existing plugin ->  read-only Doctor report           ->  concrete fixes to make
Trusted bundle  ->  release + preview matrix          ->  classified drift + stable digest
Plugin + profile -> exact clean-profile composition   ->  service-owner evidence, no repo execution
DSH agent        -> one native structured tool         ->  canonical evidence, every model surface
Local plugin UI  -> protected semantic browser route   ->  assertions + bounded visual evidence
```

No provider key is needed for capability inspection, profile preflight, Doctor, deterministic promotion, upstream impact analysis, the compatibility matrix, or the execution-lab checks.

## Get a useful result in five minutes

The currently verified release path is Windows-first and requires:

- Node.js 22.18 or newer
- DSH 0.1.1-rc.2 on `PATH` (or its exact executable passed with `--dsh`)
- pnpm 11.7.0 for the pinned DSH lifecycle environment
- A filesystem that passes the no-replace directory-rename probe used during promotion

Clone, verify, and install the plugin into a DSH Web profile:

```powershell
git clone https://github.com/builtin-pb/dsh-developer.git
cd dsh-developer
npm test
dsh plugin --profile web add .
dsh web
```

Inside DSH Web, inspect the running DSH and audit a plugin without executing that plugin repository:

```text
/dsh-developer-capabilities {}
/dsh-developer-doctor {"source":"C:/path/to/plugin","skipRuntime":false}
```

Have a saved Creator export? Turn it into a new tested bundle:

```text
/dsh-developer-promote {"source":"C:/path/to/hello-dsh.creator.json","output":"C:/path/to/hello-dsh"}
```

The output directory must not exist, and its basename must match the exported plugin name. Promotion does not install into a real profile, replace an existing directory, publish a package, or change GitHub state. Review the result, then install it deliberately:

```powershell
dsh plugin --profile headless add C:\path\to\hello-dsh
dsh --profile headless --dump-config
```

## Pick the route that matches your work

| You have | Start here | What you get |
| --- | --- | --- |
| A DSH Creator JSON export | `promote` | A new deterministic DSH + Codex plugin bundle, or a retained staging directory with the blocking failure |
| An existing plugin repository | `doctor` | A read-only audit of structure, safety, compatibility, documentation, and native lifecycle eligibility |
| An unfamiliar DSH installation | `capabilities` | Exact runtime, package, lane, evidence-strength, and digest information |
| A plugin intended for a specific profile | `preflight` | Clean-profile composition evidence for every statically required Cordis service, without installing or loading repository code |
| A plugin facing a DSH upgrade | `impact` | The exact package, public declaration, entry, dependency, and injected-service surfaces that changed |
| This product source or a reproducible promoted bundle | `compatibility` | Witnessed behavior on exact release and preview DSH lanes, plus classified revalidation triggers |
| A Windows host that needs stronger execution isolation | `lab`, then `admit-cell` | Evidence for a bounded WSL2/Bubblewrap boundary before the isolated-cell API is exposed |
| A local plugin UI that needs agent verification | `dsh_developer {"operation":"ui"}` | Scoped provider admission, exact operation names, authority containment, and visible catalog cost |
| A model-guided development task | `$dsh-developer` | The same accountable Agent Skill in DSH and Codex, backed by a native structured DSH tool |

## What Doctor checks

Doctor is more than a manifest linter. Its release catalogue covers:

- stable ordinary-file snapshots, portable paths, case collisions, binary content, dependency trees, size limits, and credential-shaped material;
- npm, DSH bundle, Codex plugin, Agent Skill, local-reference, documentation, test-guidance, compatibility, and MIT-license contracts;
- exact DSH 0.1.1-rc.2 compatibility, with DSH 0.1.2-alpha.2 treated only as preview evidence;
- byte-for-byte reproduction of promoted bundles from their fingerprinted Creator provenance;
- native module registration plus a witnessed clean-profile DSH install, load, discovery, and uninstall, with package installation offline and lifecycle scripts disabled; and
- a fresh final tree fingerprint so a passing report cannot silently describe earlier bytes.

`--skip-runtime` is useful while exploring a repository, but it is never release evidence and cannot be used during promotion.

## Catch profile failures before boot

A plugin can be valid yet still wait forever for a service absent from its target profile. Preflight derives required `inject` services from a stable, read-only source snapshot, maps those services to declarations in the exact installed DSH graph, and asks DSH itself to compose a disposable clean profile:

```powershell
node bin/dsh-developer.js preflight --source C:\path\to\plugin --profile headless --dsh D:\path\to\dsh.cmd
```

The selected official DSH lane runs only its config-dump path; the plugin repository is neither installed nor loaded, the child environment excludes credentials, and the disposable profile is removed afterward. Preflight fails closed on dynamic `inject` assignments, reports optional injections without treating them as boot requirements, and rejects required service-owner packages placed in `dependencies` or `optionalDependencies`, where a profile-local copy can shadow DSH's host instance. PASS means the clean composition unconditionally mounts at least one installed owner for each required service. It is composition evidence—not activation proof, plugin behavior, or a claim about a customized user's full stack.

CI records this contract for both `headless` and `web`: release failures block, while preview failures remain visible advisory evidence.

## Keep shipping as DSH moves

Doctor proves one package against the blocking release lane. Impact analysis first narrows an upgrade to the upstream packages and Cordis services the plugin actually declares or uses:

```powershell
node bin/dsh-developer.js impact --source C:\path\to\plugin --release-dsh D:\release\dsh.cmd --preview-dsh D:\preview\dsh.cmd
```

It reads both package-declared official DSH entries without executing them, maps `ctx` services to the packages that publish their Cordis declarations, and compares public exports, declaration files, entries, peer contracts, runtime dependencies, and DSH metadata. Add `dshDeveloper.upstream.services` and `dshDeveloper.upstream.packages` to `package.json` for an explicit machine-readable attachment declaration; inferred but undeclared surfaces stay visible as warnings, while dynamic `inject` assignments block the completeness claim. A stable digest binds the result to the final unchanged plugin tree.

The compatibility matrix then answers the harder question: does the exact same trusted tree still behave on the preview lane?

From DSH Web, the running DSH is the release lane unless `releaseDsh` is supplied:

```text
/dsh-developer-compatibility {"source":"C:/path/to/plugin","previewDsh":"D:/preview/dsh.cmd"}
```

From the CLI, name both installations explicitly:

```powershell
node bin/dsh-developer.js compatibility --source C:\path\to\plugin --release-dsh D:\release\dsh.cmd --preview-dsh D:\preview\dsh.cmd
```

The matrix first runs non-runtime Doctor, accepts only package-declared official DSH 0.1.1-rc.2 and 0.1.2-alpha.2 entries, and reruns each lane's capability and self-lifecycle evidence. It exercises the target plugin lifecycle only for dsh-developer itself or byte-for-byte reproducible promoted output—never an arbitrary repository. Release failure is blocking; preview failure remains visible but advisory. A report also requires an unchanged final source fingerprint, classifies each drift trigger as `contract` or `package-version`, and ends with a stable digest.

## Give DSH agents a safe, efficient UI path

dsh-developer does not ship another browser engine. It composes the official DSH MCP bridge with upstream Playwright or Chrome DevTools providers, then owns the missing harness-level pieces: scoped admission, operation mapping, authority containment, catalogue-cost evidence, and a snapshot-first verification contract.

For ordinary coding work, use the official [Playwright CLI](https://github.com/microsoft/playwright-cli) when it is already installed; Microsoft recommends its skill-oriented route for lower model-context cost. Use persistent MCP tools when exploration benefits from a live browser session. The bundled Playwright MCP preset is opt-in and pins the currently exercised provider contract:

```powershell
npm install --prefix D:\dsh-ui --ignore-scripts --no-audit --no-fund @playwright/mcp@0.0.79
$env:PLAYWRIGHT_MCP_ENTRY='D:\dsh-ui\node_modules\@playwright\mcp\cli.js'
$env:PLAYWRIGHT_MCP_EXECUTABLE_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:DSH_DEVELOPER_UI_OUTPUT='D:\dsh-ui\evidence'
dsh web --patch .\presets\playwright-mcp.cordis.yml
```

`--ignore-scripts` avoids an implicit browser download; omit it only when you deliberately want the provider's install behavior. DSH starts the provider through its own Node executable and the absolute JavaScript entry, avoiding platform-specific command shims. On another platform, point the environment variables at the corresponding paths. Then, from the DSH agent that will perform the work:

```text
dsh_developer {"operation":"ui"}
```

PASS means the calling agent—not merely the global host—can see a complete semantic interaction surface and that dangerous tools are absent or protected. The report returns exact tool names and the approximate JSON characters their schemas add to the model catalogue. The `dsh_ui` guard admits only a closed set of semantic operations and denies credential-bearing or non-loopback navigation. The preset adds an isolated in-memory profile, browser sandbox, loopback request filter, loopback-only proxy sink for remote HTTP(S), no automatic action snapshots, no code generation, and an 8 MiB output cap.

The default omits image responses. Set `DSH_DEVELOPER_UI_IMAGES=allow` before DSH starts only when the task needs a deliberate visual checkpoint. Use accessibility snapshots or targeted find for actions, wait on concrete DOM state, inspect error-level console output, and take CSS-scale screenshots only at meaningful states. Page content is untrusted data; a browser is not a security boundary. See the full [agent-native UI contract](skills/dsh-developer/references/agent-native-ui.md).

## One native tool for every DSH agent surface

DSH's public tool registry is the canonical model-facing extension seam. dsh-developer registers one global `dsh_developer` tool, so its evidence operations reach headless agents, DSH Web agents, Code Mode programs, and the preview ACP automation profile without teaching each transport a private protocol.

```json
{"operation":"doctor","source":"C:/path/to/plugin","skipRuntime":true}
```

The operation is one of `capabilities`, `doctor`, `preflight`, `impact`, `compatibility`, or `ui`. Operation-specific arguments are closed and validated before work begins; cancellation flows through the DSH tool pipeline. Native presentation stays compact, while Code Mode receives the canonical JSON report. `ui` inspects the calling agent's visible tool registry but never launches or controls a browser. Promotion, repository edits, UI control, package publication, and isolation executors are deliberately absent because they need stronger authority or a separate admission path.

Using one operation-discriminated tool instead of five independent schemas keeps the model-visible catalog small. The plugin imports no private DSH internals and no profile-local copy of the tool runtime; exact release and preview preflight proves that `tools` comes from the host. The controlled lifecycle witness now fails unless DSH can register and resolve the tool definition. See DSH's official [tool authoring reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md).

## Why the rest is also native DSH

Installing dsh-developer loads its real `index.js` entry through DSH. The plugin registers one model- and user-invocable Agent Skill, the structured model tool above, absolute CLI and UI-preset paths for DSH shell environments, and nine direct DSH Web commands:

```text
/dsh-developer-capabilities {}
/dsh-developer-compatibility {"source":"C:/path/to/plugin","previewDsh":"D:/preview/dsh.cmd"}
/dsh-developer-doctor {"source":"C:/path/to/plugin","skipRuntime":false}
/dsh-developer-impact {"source":"C:/path/to/plugin","previewDsh":"D:/preview/dsh.cmd"}
/dsh-developer-preflight {"source":"C:/path/to/plugin","profile":"headless"}
/dsh-developer-promote {"source":"C:/path/export.json","output":"C:/path/new-plugin"}
/dsh-developer-lab {"distro":"Ubuntu-22.04"}
/dsh-developer-admit-cell {"distro":"Ubuntu-22.04"}
/dsh-developer-ui {}
```

Headless, ACP, and JSON-RPC surfaces do not consume the Web command registry, but they do consume the native tool registry. Shell-capable surfaces also receive `DSH_DEVELOPER_BIN`; shell execution still follows that surface's normal sandbox and approval policy.

## Use the CLI directly

Every native operation also has a scriptable CLI. Add `--json` when another tool should consume the evidence.

```powershell
node bin/dsh-developer.js capabilities --dsh D:\path\to\dsh.cmd
node bin/dsh-developer.js compatibility --source C:\path\to\plugin --release-dsh D:\release\dsh.cmd --preview-dsh D:\preview\dsh.cmd
node bin/dsh-developer.js doctor --source C:\path\to\plugin --dsh D:\path\to\dsh.cmd
node bin/dsh-developer.js impact --source C:\path\to\plugin --release-dsh D:\release\dsh.cmd --preview-dsh D:\preview\dsh.cmd
node bin/dsh-developer.js preflight --source C:\path\to\plugin --profile headless --dsh D:\path\to\dsh.cmd
node bin/dsh-developer.js promote --source C:\path\to\export.json --output C:\path\to\new-plugin --dsh D:\path\to\dsh.cmd
node bin/dsh-developer.js fingerprint --source C:\path\to\creator-draft.json
```

Try the bundled export without risking an existing destination:

```powershell
node bin/dsh-developer.js doctor --source examples\hello-dsh.creator.json
node bin/dsh-developer.js promote --source examples\hello-dsh.creator.json --output ..\hello-dsh
```

If `dsh` is not on `PATH`, pass `--dsh`. The selected DSH executable is trusted input and is actually executed; review where it came from before using it as evidence.

## Stronger isolation for execution-bearing work

The optional execution lab is for Windows hosts with WSL2, a non-root Linux user, systemd user scopes, Bubblewrap, and `prlimit`. It runs fixed keyless conformance fixtures—not a model, repository, build script, or caller command—and fails closed when the host cannot prove the boundary.

```powershell
node bin/dsh-developer.js lab --wsl-distro Ubuntu-22.04
node bin/dsh-developer.js admit-cell --dsh D:\path\to\dsh.cmd --wsl-distro Ubuntu-22.04
```

A passing admission can issue an opaque, in-process grant to the JavaScript API exported from `dsh-developer/isolated-cell`. That API imports a bounded UTF-8 text tree into a disposable, network-free, credential-free Bubblewrap workspace, runs one operation at a time, stages a sealed complete result outside the source, and verifies cleanup. The native admission command does not itself expose a general arbitrary-command CLI.

The provider shares the WSL2 kernel; it is not a microVM and claims no project-specific seccomp filter. Read the exact [execution-lab contract](skills/dsh-developer/references/execution-lab.md) and [isolated-cell contract](skills/dsh-developer/references/isolated-cell.md) before integrating the API.

## Use it from Codex

The checkout already contains `.codex-plugin/plugin.json` and exposes the same canonical skill used by DSH. In Codex, ask `$plugin-creator` to add this existing plugin folder to a personal marketplace, refresh Codex, install **dsh-developer** from that local source, and invoke `$dsh-developer` in a new task. This follows the [official local-plugin testing flow](https://learn.chatgpt.com/docs/build-plugins); there is no second Codex-only workflow to drift.

## Compatibility and safety boundaries

- **Blocking release lane:** public DSH 0.1.1-rc.2.
- **Preview lane:** DSH 0.1.2-alpha.2 is inspectable but not blocking release evidence.
- **Other versions:** capabilities remain inspectable, but dsh-developer makes no compatibility claim.
- **Compatibility execution:** the matrix executes only exact product source or reproducible promoted bytes; arbitrary repositories receive no behavior claim.
- **Untrusted repositories:** Doctor reads bounded text snapshots and does not execute arbitrary repository code. Controlled execution is reserved for reproducible generated output and this product's own lifecycle proof.
- **Profile preflight:** only DSH's config-dump path runs in a disposable credential-free profile; the repository is not installed or loaded, and PASS is not a behavior claim.
- **Native model tool:** exposes read/evidence operations only, including scoped UI-provider admission. It does not promote, edit, publish, install into real profiles, control a browser, or open an isolation executor.
- **Protected UI namespace:** `dsh_ui` is restricted to a closed semantic allowlist and loopback verification; unknown future tools fail closed. Other MCP namespaces remain untouched and are not claimed as protected.
- **Destinations:** promotion creates one absent sibling directory through private staging and a probed no-replace rename. It never merges or overwrites.
- **Credentials:** deterministic paths do not need a model or provider key, and credentials must not enter Creator exports, plugin trees, child environments, reports, or bundles.
- **Windows sandboxing:** DSH's ACL backend is reported as partial rather than presented as whole-environment containment. Use the admitted WSL2/Bubblewrap route when that stronger boundary is required.

For the complete input and authority rules, see the [Creator export contract](skills/dsh-developer/references/creator-export.md) and [safety boundary](skills/dsh-developer/references/safety.md).

## Develop dsh-developer

The deterministic suite is keyless:

```powershell
npm run validate
npm pack --dry-run
```

To add the host-bound WSL and Windows process-tree checks:

```powershell
$env:DSH_DEVELOPER_WSL_LAB_TEST='1'
$env:DSH_DEVELOPER_PROCESS_TEST='1'
npm test
```

## License

[MIT](LICENSE)
