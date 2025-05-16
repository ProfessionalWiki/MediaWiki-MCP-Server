.PHONY: install update build watch test lint run dev

NODE_VERSION := 22

ENTRYPOINT := build/index.js

install:
	docker run -it --rm -v "$(CURDIR)":/home/node/app -w /home/node/app -u node node:$(NODE_VERSION) npm install

update:
	docker run -it --rm -v "$(CURDIR)":/home/node/app -w /home/node/app -u node node:$(NODE_VERSION) npm update

build:
	docker run -it --rm -v "$(CURDIR)":/home/node/app -w /home/node/app -u node node:$(NODE_VERSION) npm run build

watch:
	docker run -it --rm -v "$(CURDIR)":/home/node/app -w /home/node/app -u node node:$(NODE_VERSION) npm run watch

test:
	docker run -it --rm -v "$(CURDIR)":/home/node/app -w /home/node/app -u node node:$(NODE_VERSION) npm run test

lint:
	docker run -it --rm -v "$(CURDIR)":/home/node/app -w /home/node/app -u node node:$(NODE_VERSION) npm run lint

run:
	docker run -it --rm -v "$(CURDIR)":/home/node/app -w /home/node/app -u node node:$(NODE_VERSION) node build/index.js

dev: build
	docker run -d --name mcp_server_watcher --rm -v "$(CURDIR)":/home/node/app -w /home/node/app -u node node:$(NODE_VERSION) npm run watch
	@echo "Watcher container 'mcp_server_watcher' started."
	@bash -c '\
		INSPECTOR_PID=""; \
		cleanup() { \
			echo ""; \
			echo "Initiating cleanup sequence..."; \
			echo "Attempting to stop watcher container mcp_server_watcher..."; \
			if docker stop mcp_server_watcher >/dev/null 2>&1; then \
				echo "Watcher container mcp_server_watcher stopped successfully."; \
			else \
				echo "Watcher container mcp_server_watcher may have already been stopped or failed to stop."; \
			fi; \
			if [ -n "$$INSPECTOR_PID" ]; then \
				echo "Checking inspector process $$INSPECTOR_PID..."; \
				if kill -0 $$INSPECTOR_PID 2>/dev/null; then \
					echo "Stopping inspector process $$INSPECTOR_PID..."; \
					kill $$INSPECTOR_PID; \
					echo "Inspector process $$INSPECTOR_PID signaled to terminate."; \
				else \
					echo "Inspector process $$INSPECTOR_PID was not running or does not exist."; \
				fi; \
			else \
				echo "Inspector PID was not set; skipping stop for inspector process."; \
			fi; \
			echo "Cleanup sequence complete."; \
		}; \
		trap '\''cleanup; echo "Subshell exiting due to signal."; exit 130'\'' INT; \
		trap '\''cleanup; echo "Subshell exiting due to signal."; exit 143'\'' TERM; \
		echo "Starting inspector: npx -y @modelcontextprotocol/inspector node $(ENTRYPOINT)"; \
		npx -y @modelcontextprotocol/inspector node $(ENTRYPOINT) & INSPECTOR_PID=$$!; \
		if [ -z "$$INSPECTOR_PID" ]; then \
			echo "Failed to start inspector or capture PID. Aborting."; \
			cleanup; \
			exit 1; \
		fi; \
		echo "Inspector started with PID $$INSPECTOR_PID. Watcher mcp_server_watcher is running."; \
		echo "Press Ctrl+C to stop both services."; \
		wait $$INSPECTOR_PID; \
		INSPECTOR_EXIT_CODE=$$?; \
		echo "Inspector process (PID $$INSPECTOR_PID) exited with code $$INSPECTOR_EXIT_CODE."; \
		echo "Inspector process completed. Performing final cleanup..."; \
		cleanup; \
		echo "Subshell exiting with code $$INSPECTOR_EXIT_CODE."; \
		exit $$INSPECTOR_EXIT_CODE; \
	'
