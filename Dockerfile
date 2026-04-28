# ----- Build Stage -----
FROM node:lts-alpine AS builder
WORKDIR /app

# Copy package and configuration
COPY package.json package-lock.json tsconfig.json ./

# Copy source code
COPY src ./src

# Install dependencies and build
RUN npm ci && npm run build

# ----- Production Stage -----
FROM node:lts-alpine

ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="MediaWiki MCP Server" \
      org.opencontainers.image.description="Model Context Protocol (MCP) server for MediaWiki" \
      org.opencontainers.image.authors="Professional Wiki" \
      org.opencontainers.image.url="https://professional.wiki/en/mediawiki-mcp-server" \
      org.opencontainers.image.source="https://github.com/ProfessionalWiki/MediaWiki-MCP-Server" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${GIT_SHA}"

WORKDIR /app

# Copy built artifacts
COPY --from=builder /app/dist ./dist

# Copy package.json and lockfile for production install
COPY package.json package-lock.json ./

# Copy server.json (loaded at runtime for server name, title, and version)
COPY server.json ./

# Install only production dependencies
RUN npm ci --omit=dev --ignore-scripts

# Use a non-root user for security
RUN addgroup -S nodejs \
	&& adduser -S -G nodejs nodejs \
	&& chown -R nodejs:nodejs /app
USER nodejs

ENV NODE_ENV=production

# Set environment variables for StreamableHTTP
ENV PORT=8080
ENV MCP_TRANSPORT=http
ENV MCP_BIND=0.0.0.0

# Expose HTTP port
EXPOSE 8080

# Add health check for container orchestration
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD [ "node", "-e", "require('http').get('http://localhost:8080/health', (res) => process.exit(res.statusCode == 200 ? 0 : 1))" ]

# Start the server
CMD ["node", "dist/index.js"]
