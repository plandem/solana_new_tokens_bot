FROM node:22.0-slim

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn --pure-lockfile --force

COPY . .
RUN yarn build
CMD yarn start
