FROM node:26.13.0-bookworm-slim@sha256:067b2d425f1204b5a898ae3d3145f7524c1425a4096a62b0f67dd4344a494440
WORKDIR /opt/loopwright
COPY node_modules ./node_modules
COPY packages ./packages
COPY package.json package-lock.json ./
ENV HOME=/tmp/home PI_OFFLINE=1
USER 1000:1000
ENTRYPOINT ["node"]
