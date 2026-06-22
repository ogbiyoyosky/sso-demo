# Static files only — nginx serves them on port 80 inside the container,
# mapped to a host port by docker-compose.
#
# The same image is built twice (App One / App Two) for the SSO demo; build
# args bake in which backend this copy talks to and how it presents itself.
FROM nginx:1.27-alpine
ARG BACKEND_URL=http://localhost:3000
ARG APP_NAME="App One"
ARG ACCENT=#2563eb
COPY index.html /usr/share/nginx/html/index.html
RUN sed -i \
      -e "s|__BACKEND_URL__|${BACKEND_URL}|g" \
      -e "s|__APP_NAME__|${APP_NAME}|g" \
      -e "s|__ACCENT__|${ACCENT}|g" \
      /usr/share/nginx/html/index.html
EXPOSE 80
