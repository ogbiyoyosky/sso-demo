# Static single-page frontend on nginx (self-contained: inline CSS + JS).
# Built twice (Customer Portal / Internal Tools) with different build args.
FROM nginx:1.27-alpine
ARG APP_NAME="App"
ARG APP_TAGLINE="An app"
ARG ACCENT=#2563eb
COPY index.html /usr/share/nginx/html/index.html
COPY nginx.conf /etc/nginx/conf.d/default.conf
RUN sed -i \
      -e "s|__APP_NAME__|${APP_NAME}|g" \
      -e "s|__APP_TAGLINE__|${APP_TAGLINE}|g" \
      -e "s|__ACCENT__|${ACCENT}|g" \
      /usr/share/nginx/html/index.html
EXPOSE 80
