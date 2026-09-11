# Choose a development environment

Run DSH and dsh-developer natively on Windows, macOS or Linux for ordinary trusted development. This gives you the host's real filesystem, browser and DSH behavior. Use an isolated Linux cell when an agent needs to run a small, untrusted build; keep native platform tests as a separate check.

| Need | Windows | macOS |
| --- | --- | --- |
| Develop plugins and DSH itself | Native DSH + Node.js; follow the upstream toolchain | Native DSH + Node.js; [Mac setup](macos.md) |
| Isolated agent Build/Apply | WSL2 + Bubblewrap, after local admission | Apple container 1.4.1 on Apple silicon/macOS 26+, after local admission |
| Prove Windows/macOS behavior | Run the relevant native tests | Run the relevant native tests |
| Intel Mac or macOS before 26 | — | Native workflows available; isolated Build unavailable |

Native Linux supports project inspection, source guidance, host project scripts, disposable verification and Web development. Promotion uses Linux `renameat2(RENAME_NOREPLACE)` through system Python 3; an unavailable syscall fails rather than replacing a destination. The specialized isolated Build/Apply controller has no admitted native Linux provider. CI covers ordinary development separately from cell admission.

Local ordinary-development evidence covers macOS ARM64 and Debian 12 ARM64 with Node 24.19.0 and DSH 0.1.5-rc.2: a TypeScript plugin with a runtime dependency, source and archive invocation, configuration overlays, Web authentication/startup, cancellation, cleanup and occupied-port rejection. The final Linux run used UID/GID 1000 with no Linux capabilities in a disposable container; dependency installation and all checks ran as that user. npm, pnpm 11.7.0, Yarn Classic 1.22.22 and Yarn 4.18.0 preserved script arguments and exit status on both hosts.

Earlier ordinary-development runs also passed on DSH 0.1.1-rc.2 and 0.1.5-rc.1. Rendered packed Client behavior was checked on macOS with 0.1.5-rc.1 and 0.1.5-rc.2; Linux UI evidence covers compilation and automated registry/component tests.

The subsequent [CI run at `09e896c`](https://github.com/builtin-pb/dsh-developer/actions/runs/34555142751) passed all six native development jobs: DSH 0.1.1-rc.2 and 0.1.5-rc.2 on Windows, macOS and Ubuntu with Node 24.19.0. This adds observed native Windows source/archive verification, overlays, HTTP authentication, process cleanup and background-browser suppression. It does not establish rendered Windows browser automation, every architecture or musl. That run still had separate general-test and authority-probe failures; see [verification results](verification.md) for their follow-up and the remaining scope.

## Why these routes

[Apple container](https://github.com/apple/container) gives each Linux container its own lightweight VM. That makes it a useful fit for independent, disposable agent workspaces on supported Macs. This provider uses a fixed image and no shared host folders or network. Its extra guest CPU and host runtime overhead are reported explicitly.

[WSL2](https://learn.microsoft.com/en-us/windows/wsl/compare-versions) supplies the Linux environment on Windows. The existing Bubblewrap provider adds namespaces, mount masks, a cleared environment, systemd resource scopes and verified cleanup. Cells share the WSL kernel. Its guarantee differs from a separate VM per cell; local conformance is required before execution.

[Lima](https://lima-vm.io/docs/config/vmtype/vz/) remains a plausible broader Mac compatibility route, especially for Intel hardware and older macOS. It is not an admitted provider here. A general-purpose VM needs additional workspace, transfer, resource and recovery controls before it can satisfy this project's execution contract.

[Windows Sandbox](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli) is a candidate for native Windows isolation. Its documented CLI process-I/O limitations make reliable bounded command transport and artifact transfer an unresolved integration task here. It is not used as a fallback.

These choices are based on the required behavior and the routes exercised by this repository. They are not a universal benchmark of every sandbox product. A Linux VM passing tests does not establish native Windows or macOS compatibility.

## Local requirements and limits

The Windows lab requires WSL2, a non-root Linux user with a home under `/home`, Bubblewrap, Python, `prlimit`, systemd user scopes and the resource controllers checked by the provider. Select the configured distro:

```powershell
node bin/dsh-developer.js lab --wsl-distro Ubuntu-22.04
node bin/dsh-developer.js admit-cell --wsl-distro Ubuntu-22.04
```

Use the [Mac setup guide](macos.md) for the Apple service and exact image. Both providers intentionally accept only small ordinary UTF-8 trees, excluding dependency trees and credentials. Export limits are 4 MiB, 256 files and 512 KiB per file. Full upstream builds should follow DSH's own native source workflow.

The [execution contract](../skills/dsh-developer/references/execution-lab.md) defines each provider's limits, cleanup and evidence. Never substitute a different provider merely because its command launches successfully.
