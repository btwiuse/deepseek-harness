# The dsh web image, built with bun instead of pnpm. Same runtime contract as
# the historical pnpm image (node:22-bookworm base, `dsh web --dev` on $PORT),
# but the install/build layer swaps pnpm for bun.
#
# Measured on a 48-core host (cold install), bun is NOT a significant
# total-build win for this repo: bun install (10.9s) is ~2.3x faster than pnpm
# install (24.7s), but install is only ~15% of the build; the tsc -b compile
# that dominates `pnpm run build` (~166s of ~191s) runs under node either way,
# and running tsc itself under bun's runtime is not faster (measured ~83s vs
# ~88s, within noise). Total: ~180s with bun vs ~191s with pnpm on this host.
# On machines with slower network the install-phase win grows, but it never
# approaches "significant" while tsc dominates.
#
# Costs of this variant, before adopting:
#  - bun ignores pnpm-lock.yaml (its migration fails on this lockfile's link:
#    overrides), so `bun install` here resolves fresh from package.json ranges
#    and writes a bun.lock inside the image — nothing is pinned for bun, by
#    design (no bun.lock is committed). Range drift is accepted: this variant
#    builds with vite 6.4.3 / esbuild 0.28 / tsdown 0.22.14 while pnpm-lock
#    pins vite 5.4.21 / esbuild 0.21.5 / tsdown 0.22.2 — web dist output and CI
#    parity can differ. If you ever need reproducibility, commit a bun.lock and
#    switch back to --frozen-lockfile.
#  - Two repo fixes were required for bun (already applied in the repo):
#    packages/host/apiproxy/package.json had a duplicate "@deepseek-ai/cordis"
#    devDependency key (bun hard-fails on duplicate JSON keys, pnpm tolerated
#    it), and root package.json "workspaces" had to list examples (bun reads
#    workspace membership only from package.json, not pnpm-workspace.yaml;
#    without it the build fails on src-level imports in examples/).
FROM node:22-bookworm

WORKDIR /app

# bun binary from the official image; node stays the runtime for the built CLI
# (`dsh web` executes under node) and for tsc/tsdown/vite inside `bun run build`.
# Pin the tag (e.g. oven/bun:1.3.14) for reproducible builds.
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

# The whole checkout; .dockerignore keeps node_modules, build outputs, and VCS
# metadata out of the build context.
COPY . .

# Install workspace dependencies (resolved fresh from package.json ranges —
# bun ignores pnpm-lock.yaml, and no bun.lock is committed), then build every
# package and the web frontend dist (node-pty compiles here via the image's
# toolchain; bun trusts it by default, koffi's blocked postinstall is fine —
# koffi ships prebuilt platform packages).
RUN bun install \
 && bun run build

# The global `dsh` command: the built CLI bin. Its split mode chunks sit
# beside it, and workspace dependencies resolve through the repo's node_modules.
RUN ln -s /app/apps/cli/lib/bin.js /usr/local/bin/dsh

# Harness user data lives under the harness home (persist with a volume).
ENV DSH_HOME=/root/.dsh

WORKDIR /root

# $PORT is the platform convention dsh web reads for its default listen port;
# override at runtime: docker run -e PORT=9000 ...
ENV PORT=8080
EXPOSE 8080

# No entrypoint script: `dsh web --dev --host 0.0.0.0` serves on $PORT,
# binding every interface, with every /api browser-trust fence disabled
# (development deployment).
CMD ["dsh", "web", "--dev", "--host", "0.0.0.0"]
