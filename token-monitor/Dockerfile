FROM node:22.0-slim

WORKDIR /app

RUN apt update
RUN apt install --assume-yes --no-install-recommends build-essential python3

COPY package.json yarn.lock ./
RUN yarn --pure-lockfile --force

COPY . .
RUN yarn build
CMD yarn start
