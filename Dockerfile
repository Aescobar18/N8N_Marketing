# Imagen oficial con Playwright + Chromium + dependencias
FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# Copiar package.json y lock (mejor cache)
COPY package*.json ./

# Instalar dependencias
RUN npm install --omit=dev

# Copiar TODO el proyecto (por si luego agregas más archivos)
COPY . .

# Puerto que usará Render
EXPOSE 3000

# ⚠️ NO es necesario setear executable path manualmente
# Playwright ya sabe dónde está Chromium en esta imagen

# Iniciar app
CMD ["node", "server.js"]
