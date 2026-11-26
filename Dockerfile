FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# Compila o TypeScript (falha o build se tiver erro de tipo) e tira as dependências de desenvolvimento.
RUN npm run build && npm prune --omit=dev
# A mesma imagem serve para a API e para os consumidores; o compose.yaml escolhe o comando.
CMD ["node", "dist/api.js"]
