# Specify the base Docker image. You can read more about
# the available images at https://crawlee.dev/docs/guides/docker-images
# You can also use any other image from Docker Hub.
# use node base image as builder to speed up the build step instead of usiging the full playwright image
FROM apify/actor-node:22 AS builder
# override the default working directory set in the base image
WORKDIR /home/myuser

# Copy just package.json and package-lock.json
# to speed up the build using Docker layer cache.
COPY --chown=myuser package*.json ./

# Install all dependencies. Don't audit to speed up the installation.
RUN npm install --include=dev --audit=false

# Next, copy the source files using the user set
# in the base image.
COPY --chown=myuser . ./

# Install all dependencies and build the project.
# Don't audit to speed up the installation.
RUN npm run build

# Build Ghostery blockers for content filtering
RUN npm run build:playwright-blockers

# Create final image
FROM apify/actor-node-playwright-firefox:22-1.54.1

# Copy just package.json and package-lock.json
# to speed up the build using Docker layer cache.
COPY --chown=myuser package*.json ./
COPY --chown=myuser policies.json ./
COPY --chown=myuser patches ./patches

# Install NPM packages, skip optional and development dependencies to
# keep the image small. Avoid logging too much and print the dependency
# tree for debugging
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

# Copy built JS files from builder image
COPY --from=builder --chown=myuser /home/myuser/dist ./dist

# Copy Ghostery blockers from builder image
COPY --from=builder --chown=myuser /home/myuser/blockers ./blockers

# Next, copy the remaining files and directories with the source code.
# Since we do this after NPM install, quick build will be really fast
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
CMD ["npm", "run", "start:prod", "--silent"]
