FROM node:20-alpine
WORKDIR /app

# Copiamos las dependencias y las instalamos
COPY package*.json ./
RUN npm install --production

# Copiamos el código del servidor
COPY . .

# Exponemos el puerto 3000 para que Easypanel lo enrute
EXPOSE 3000

# Arrancamos el motor
CMD ["npm", "start"]