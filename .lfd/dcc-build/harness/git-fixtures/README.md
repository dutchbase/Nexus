# Git Fixtures

Local Git repositories with configurable test modes.

## Usage

```bash
./create-fixtures.sh              # Create in default location
./create-fixtures.sh --clean      # Clean and recreate
./create-fixtures.sh --root PATH  # Custom root
```

## Layout

```
.fixtures-tmp/
├── remotes/       ← bare repos
│   ├── va-jobs-platform.git
│   ├── corporate-site.git
│   ├── customer-portal.git
│   └── billing-api.git
└── repos/         ← working checkouts
    ├── va-jobs-platform/
    ├── corporate-site/
    ├── customer-portal/     ← dirty
    └── billing-api/
```

## Projects

- **va-jobs-platform**, **corporate-site**, **billing-api**: Clean
- **customer-portal**: Intentionally dirty (tests dirty-state handling)

## Lint Failure Toggle

```bash
touch repos/<slug>/.lint-should-fail  # Force lint to fail
rm repos/<slug>/.lint-should-fail     # Restore success
```

Tests can create/delete the marker to verify validation behavior without running a real linter.
