FROM docker.io/cloudflare/sandbox:0.6.6

# Required during local development to access exposed ports
EXPOSE 8080

# Copy and install Claude SDK driver
COPY sandbox/package.json sandbox/driver.mjs /app/
WORKDIR /app
RUN npm install

WORKDIR /workspace
