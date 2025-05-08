FROM node:18-alpine

WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install app dependencies
RUN npm install

# Bundle app source
COPY . .

# Expose the port the app runs on. This will be the port *inside* the container.
# The actual host port is mapped during `docker run` (e.g., -p 3000:3000).
# The application inside the container will listen on the port defined by the
# PORT environment variable, or 3000 if not set.
EXPOSE 3000

# Define the command to run the application
CMD [ "node", "index.js" ] 