# crowdsim — development entry points.
#
# `make test` must not generate load against anything: the unit, CLI and GUI suites run entirely
# against fakes (a stub k6 on PATH, a temporary profile, a loopback HTTP server). Only `make test-e2e`
# starts a real generator, and only against a container on 127.0.0.1.

SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

.PHONY: help install test test-unit test-cli test-gui test-e2e test-k8s lint gui gui-dev gui-build \
        image image-smoke image-run docs docs-serve clean

# The docs toolchain is Python and is not needed to build or test the tool itself, so it lives in a
# throwaway virtualenv rather than in the repository's dependencies.
DOCS_VENV ?= .venv-docs

IMAGE ?= crowdsim:dev

help: ## show this help
	@grep -hE '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/\t/' | column -t -s $$'\t'

install: ## install dev + GUI dependencies (bats, express, vite, react)
	npm install

test: test-unit test-gui test-cli ## everything that does not generate load

# The glob is expanded by the shell, not by node: `node --test` only learned to glob in v22, and CI runs
# the LTS. A quoted pattern reaches node verbatim there and it fails with "Could not find".
test-unit: ## pure generator logic (mix, cache classification, summary) — node:test
	node --test tests/unit/*.test.js

test-cli: ## bin/crowdsim behaviour: safety gates, args, profile resolution — bats
	npx bats tests/cli

test-gui: ## GUI API: profiles, run launching, path traversal, gate propagation — node:test
	node --test tests/gui/*.test.js

test-e2e: ## REAL run against a local nginx (needs docker + k6) — the only suite that loads anything
	tests/e2e/run.sh

test-k8s: ## ci/kubernetes manifests: rendered client-side, safety invariants asserted (needs kubectl)
	tests/k8s/check.sh

lint: ## syntax-check the shell driver and the k6 script
	bash -n bin/crowdsim
	node --check k6/live-event.js
	@for f in k6/lib/*.js lib/*.mjs; do node --check "$$f"; done

gui: gui-build ## build the UI and serve it (http://127.0.0.1:8787)
	node gui/server/index.js

gui-dev: ## Vite dev server with API proxy (http://127.0.0.1:5173)
	npm run dev --workspace gui/ui

gui-build: ## produce gui/ui/dist
	npm run build --workspace gui/ui

image: ## build the single image (driver + generator + GUI) as $(IMAGE)
	docker build -t $(IMAGE) .

image-smoke: ## assert the image is the tool and the gates survived the build
	tests/image/smoke.sh $(IMAGE)

image-run: ## run the GUI from the image on http://127.0.0.1:8787 (token printed below)
	@token=$$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'); \
	echo "token: $$token"; \
	echo "open:  http://127.0.0.1:8787  (paste the token when asked)"; \
	docker run --rm -p 127.0.0.1:8787:8787 \
	  -e CROWDSIM_GUI_BIND=0.0.0.0 -e CROWDSIM_GUI_TOKEN="$$token" \
	  -v "$$PWD/profiles:/profiles" -v "$$PWD/out:/out" \
	  $(IMAGE) crowdsim serve

$(DOCS_VENV)/bin/mkdocs:
	python3 -m venv $(DOCS_VENV)
	$(DOCS_VENV)/bin/pip install -q -r docs/requirements.txt

docs: $(DOCS_VENV)/bin/mkdocs ## build the documentation site into site/ (--strict, as CI does)
	$(DOCS_VENV)/bin/mkdocs build --strict

docs-serve: $(DOCS_VENV)/bin/mkdocs ## preview the docs site with live reload (http://127.0.0.1:8000)
	$(DOCS_VENV)/bin/mkdocs serve

clean:
	rm -rf out gui/ui/dist site
