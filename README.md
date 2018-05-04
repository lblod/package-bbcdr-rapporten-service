# packages-bbcdr-rapporten-service
Microservice that packages a bbcdr report by creating a zip file with the linked files and a metadata file.

## installation
To add the service to your stack, add the following snippet to docker-compose.yml:

```
services:
  packagereports:
    image: lblod/package-bbcdr-rapporten-service
```

## REST API
### POST /package-bbcdr-reports/
Trigger packaging
Returns `202 Accepted` if the process was started

Returns `503 Service Unavailable` if already running

## Development

```
services:
  packagereports:
    image: semtech/mu-javascript-template:1.2.1
    ports:
      - 8888:80
    environment:
      NODE_ENV: "development"
    volumes:
      - /path/to/your/code:/app/
```
