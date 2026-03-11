setup:
	./scripts/bootstrap_ubuntu.sh

verify:
	./scripts/verify_setup.sh

test:
	@if [ -x .venv/bin/python ]; then .venv/bin/python -m pytest -q; else python3 -m pytest -q; fi

dashboard-build:
	cd dashboard && npm run build

dashboard-package:
	cd dashboard && npm run package
