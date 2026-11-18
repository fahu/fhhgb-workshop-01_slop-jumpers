FROM node:24.21.0-alpine AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY shared/ /shared/
COPY frontend/ ./
RUN npm run build

FROM maven:3.9.11-eclipse-temurin-21 AS backend
WORKDIR /backend
COPY backend/pom.xml ./
RUN mvn -B -ntp dependency:go-offline
COPY shared/ /shared/
COPY backend/src ./src
COPY --from=frontend /frontend/dist ./src/main/resources/static
RUN mvn -B -ntp verify

FROM eclipse-temurin:21-jre@sha256:18bb4a91a3dea3f03ee31d3755af34dfb40f904fc77ab56cdc2f092e32fff9c2
WORKDIR /app
RUN mkdir -p /data && chown 10001:10001 /data /app
COPY --from=backend --chown=10001:10001 /backend/target/slop-jumpers.jar /app/slop-jumpers.jar
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/slop-jumpers.jar"]
