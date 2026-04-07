FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:1.27-alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY env-config.template.js /usr/share/nginx/html/env-config.template.js
COPY docker-entrypoint-render.sh /docker-entrypoint.d/40-render-env.sh

RUN chmod +x /docker-entrypoint.d/40-render-env.sh

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
