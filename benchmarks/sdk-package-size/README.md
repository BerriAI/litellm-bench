# Clean LiteLLM package size

Stable ID: `sdk-package-size`. Measures the LiteLLM wheel, complete resolved wheel download
closure, every file installed from that closure, and downloaded artifact count before import.

Resolution is isolated from ambient `PIP_*` and `UV_*` settings. Pip runs in isolated mode, uv
ignores configuration files, and the recorded observation contains the resolver inputs, resolved
Python patch, uv/pip versions, complete artifact inventory, and SHA-256 for every wheel. Resolution
is reproducible and comparable within a campaign; mutable indexes mean historical campaigns do not
implicitly hold transitive dependency versions constant.

Installed footprint is the sum of logical sizes for all unique regular files and symlinks named by
the installed distributions' `RECORD` files. This includes site-packages, generated console scripts,
and wheel `.data` files moved into other install-scheme locations. Directories are excluded,
hard-linked regular files are counted once, symlinks contribute the link's own byte length, and
sparse files contribute logical length. Allocated bytes are deliberately not published because the
meaning is not portable across filesystems and operating systems.

The implementation follows `config → scoped prepare → probe → validated observation → pure
projection → validated result`. `PackageSizeProbe` owns installed-size inspection, the runner opens a
scope per invocation, and malformed configuration or observations use typed errors. Public IDs remain
stable. A run cannot become `ok` unless the full closure is wheels-only, the pip report matches the
downloaded inventory, every distribution has a usable `RECORD`, and the requested, resolved, and
installed LiteLLM versions match exactly. Installed-size inspection fails when any path cannot be
inspected; it never substitutes zero.

Verify with:

```sh
pnpm --filter @litellm-bench/benchmark-sdk-package-size check
pnpm --filter @litellm-bench/benchmark-sdk-package-size test
```
