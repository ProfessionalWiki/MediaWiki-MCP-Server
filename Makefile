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
	@bash ./dev_script.sh $(ENTRYPOINT) $(NODE_VERSION)
