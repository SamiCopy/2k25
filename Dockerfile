# ---------- Stage 1: Build the React client ----------
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies (non-production so it pulls devDependencies too)
COPY package*.json ./
RUN npm install --production=false

# Copy all source, build the client
COPY . .
RUN npm run build-client         # outputs into client/dist or however your package.json is set

# ---------- Stage 2: Runtime image ----------
FROM node:20-alpine
WORKDIR /app

# Set environment
ENV NODE_ENV=production

# Copy built app + server code from builder
COPY --from=builder /app /app

# Remove devDependencies to slim image
RUN npm prune --production

# Expose HTTP and P2P ports
EXPOSE 3000 5000

# Start your Node/Express + P2P server
CMD ["node", "index.js"]
