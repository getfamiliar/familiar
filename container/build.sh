#!/bin/bash
# Build the container image for the agent, based on the Dockerfile in this directory.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="effective-agent"
TAG="${1:-latest}"

echo "Building Effective Assistant agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

docker build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
