# =========================================================
# STAGE 1: Build the application
# =========================================================
FROM node:20-alpine AS builder

# Set to build-time environment
ENV NODE_ENV=production

WORKDIR /app

# Copy dependency definition files
COPY package*.json ./

# Install all dependencies (including devDependencies required for compilation)
RUN npm ci

# Copy application source code
COPY . .

# Compile the client-side SPA and bundle server.ts into dist/server.cjs
RUN npm run build


# =========================================================
# STAGE 2: Lightweight runtime image
# =========================================================
FROM node:20-alpine AS runner

WORKDIR /app

# Set container execution environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Copy package requirements
COPY package*.json ./

# Install ONLY production dependencies to keep the runtime layer minimal
RUN npm ci --omit=dev

# Copy compiled backend and frontend assets from the build stage
COPY --from=builder /app/dist ./dist

# Document the container port for internal reverse proxy / VPS configuration
EXPOSE 3000

# Define a volume point for persistent storage of database.json
VOLUME [ "/app/data" ]

# Set database location redirect if needed via environment variable (optional)
# But by default database.json is created in process.cwd() (active directory).
# To facilitate VPS persistence, we can instruct the user how to bind mount database.json.

# Start the application
CMD ["node", "dist/server.cjs"]
