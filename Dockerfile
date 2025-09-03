# Use Node.js 22
FROM node:22

# Set working dir
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Install netcat (needed for wait-for.sh)
RUN apt-get update && apt-get install -y netcat-openbsd


# Copy rest of project
COPY . .

# Copy wait script into container
COPY wait-for.sh /wait-for.sh
RUN chmod +x /wait-for.sh

# Expose backend port
EXPOSE 5000

# Default command (we'll override in docker-compose)
CMD ["npm", "start"]
