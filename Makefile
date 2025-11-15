.PHONY: install update build watch test lint run dev

NODE_VERSION := 22

ENTRYPOINT := dist/index.js

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

start:
	docker run -it --rm -v "$(CURDIR)":/home/node/app -w /home/node/app -u node node:$(NODE_VERSION) node dist/index.js

dev:
	@(sleep 2 && printf "\n💡 Tip: Replace 0.0.0.0 with localhost in the URL for MCP Inspector. The browser won't open automatically.\n") &
	docker run -it --rm -p 127.0.0.1:6274:6274 -p 127.0.0.1:6277:6277 -v "$(CURDIR)":/home/node/app -w /home/node/app -u node -e HOST=0.0.0.0 node:$(NODE_VERSION) npm run dev
