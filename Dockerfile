# Specify the base Docker image. You can read more about
# the available images at https://crawlee.dev/docs/guides/docker-images
# You can also use any other image from Docker Hub.
# use node base image as builder to speed up the build step instead of usiging the full playwright image
FROM apify/actor-node:22 AS builder
# override the default working directory set in the base image
WORKDIR /home/myuser

# Enable pnpm through Corepack. The base image runs as the non-root `myuser`, and the default
# Corepack shim location (/usr/local/bin) is root-owned, so install the shims into a
# user-writable directory and put it on PATH. The exact pnpm version comes from the
# "packageManager" field in package.json.
ENV PATH=/home/myuser/bin:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN mkdir -p /home/myuser/bin && corepack enable --install-directory /home/myuser/bin pnpm

# Copy just package.json, the lockfile, the workspace config and patches
# to speed up the build using Docker layer cache.
COPY --chown=myuser package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=myuser patches ./patches

# The base image ships a preinstalled node_modules. Remove it first so pnpm's isolated layout
# doesn't get confused by a preexisting non-pnpm node_modules. `npm install` used to overwrite it
# implicitly; pnpm does not.
RUN rm -rf node_modules && pnpm install --frozen-lockfile

# Next, copy the source files using the user set
# in the base image.
COPY --chown=myuser . ./

# Build the project.
RUN pnpm run build

# Build Ghostery blockers for content filtering
RUN pnpm run build:playwright-blockers

# Create final image
FROM apify/actor-node-playwright-firefox:22-1.55.1

# Enable pnpm through Corepack (see the builder stage for why we use a custom install directory).
ENV PATH=/home/myuser/bin:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN mkdir -p /home/myuser/bin && corepack enable --install-directory /home/myuser/bin pnpm

# Copy just package.json, the lockfile, the workspace config and patches
# to speed up the build using Docker layer cache.
COPY --chown=myuser package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=myuser policies.json ./
COPY --chown=myuser patches ./patches

# Install packages, skip development dependencies to keep the image small. Avoid logging too
# much and print the dependency tree for debugging. Optional dependencies are needed - `impit`
# ships its native bindings as one. Remove the base image's preinstalled node_modules first
# (see builder stage).
RUN rm -rf node_modules \
    && pnpm install --prod --frozen-lockfile \
    && echo "Installed packages:" \
    && (pnpm list --prod --depth Infinity || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "pnpm version:" \
    && pnpm --version \
    && pnpm store prune

# Copy built JS files from builder image
COPY --from=builder --chown=myuser /home/myuser/dist ./dist

# Copy Ghostery blockers from builder image
COPY --from=builder --chown=myuser /home/myuser/blockers ./blockers

# Next, copy the remaining files and directories with the source code.
# Since we do this after pnpm install, quick build will be really fast
# for most source file changes.
COPY --chown=myuser . ./

# Edit the TZ environment variable to set the timezone in the container.
# Most of the proxy traffic is from the US, so we set the timezone to New York.
# which can help with the bot-detection mechanisms of some websites.
ENV TZ=America/New_York

# Configure Firefox policies
ENV PLAYWRIGHT_FIREFOX_POLICIES_JSON="/home/myuser/policies.json"

# Disable experimental feature warning from Node.js
ENV NODE_NO_WARNINGS=1

# Run the image.
CMD ["pnpm", "run", "start:prod", "--silent"]
