COMPOSE := docker compose -f docker-compose.dev.yml
.DEFAULT_GOAL := help

.PHONY: help build dev

##@ Development

build: ## Build the Docker image
	$(COMPOSE) build

dev: ## Start the local server (rebuild if needed)
	$(COMPOSE) up --build

##@ Help

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*##"; section = ""} \
	/^[a-zA-Z0-9_.-]+:.*##/ { \
		if (section != "") printf "\n\033[1m%s\033[0m\n", section; \
		section = ""; \
		printf "  \033[36m%-11s\033[0m %s\n", $$1, $$2; next \
	} \
	/^##@/ { section = substr($$0, 5); next }' $(MAKEFILE_LIST)
