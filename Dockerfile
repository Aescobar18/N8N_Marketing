# Imagen base con Playwright y Chromium ya incluidos
# Esta imagen oficial ya trae todas las dependencias del sistema
FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# Copiar dependencias primero (cache de Docker)
COPY package*.json ./
RUN npm install --omit=dev

# Copiar código fuente
COPY server.js ./

# Render.com asigna el puerto via variable de entorno PORT
EXPOSE 3000

# Variable para que Playwright encuentre el Chromium de la imagen
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/ms-playwright/chromium-1097/chrome-linux/chrome

CMD ["node", "server.js"]
