# The dsh web image. Modeled on ../dsh/Dockerfile: node:22-bookworm ships the
# C++ toolchain node-pty needs to compile on Linux (its prebuilt binaries cover
# only macOS/Windows). Unlike that image, this one builds FROM the checkout
# itself — the published @deepseek-ai/dsh package predates --trusted-origin,
# --dev, and the $PORT default — installs the built CLI as a global `dsh`
# command, and starts `dsh web --dev` directly: no entrypoint wrapper, because
# the CLI maps $PORT to the listen port and --dev disables every /api
# browser-trust fence.
FROM node:22-bookworm

WORKDIR /app

# pnpm pinned to the repo's packageManager (corepack is deprecated in Node 22).
RUN npm install -g pnpm@11.7.0

# The whole checkout; .dockerignore keeps node_modules, build outputs, and VCS
# metadata out of the build context.
COPY . .

# Install workspace dependencies from the lockfile, then build every package
# and the web frontend dist (node-pty compiles here via the image's toolchain).
RUN pnpm install --frozen-lockfile \
 && pnpm run build

# The global `dsh` command: the built CLI bin. Its split mode chunks sit
# beside it, and workspace dependencies resolve through the repo's node_modules.
RUN ln -s /app/apps/cli/lib/bin.js /usr/local/bin/dsh

# Harness user data lives under the harness home (persist with a volume).
ENV DSH_HOME=/mnt/.dsh

WORKDIR /mnt

# $PORT is the platform convention dsh web reads for its default listen port;
# override at runtime: docker run -e PORT=9000 ...
ENV PORT=8080
EXPOSE 8080

# No entrypoint script: `dsh web --dev` serves on $PORT with every /api
# browser-trust fence disabled (development deployment).
CMD ["dsh", "web", "--dev"]
