FROM nginx:1.27-alpine

# 只把静态页面放进 Nginx，不依赖任何商业地图 Token
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY app.js /usr/share/nginx/html/app.js
COPY style.css /usr/share/nginx/html/style.css
COPY vendor/ /usr/share/nginx/html/vendor/

EXPOSE 80
