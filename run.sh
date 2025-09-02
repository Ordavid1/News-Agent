#!/usr/bin/env bash

set -e

# Load environment variables, copy example if needed
echo "Checking for .env file..."
if [ ! -f .env ]; then
  echo ".env not found, copying .env.example to .env"
  cp .env.example .env
  echo "Please update .env with your configuration values"
fi

# Install dependencies
echo "Installing dependencies..."
npm install

# Start Tailwind CSS build in background
echo "Starting Tailwind CSS build..."
npm run build:css &

# Start server
echo "Starting server..."
npm run dev
