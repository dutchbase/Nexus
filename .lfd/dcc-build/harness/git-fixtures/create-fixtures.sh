#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# SCRIPT_DIR is harness/git-fixtures, so ONE dirname lands at harness/ (the
# fixture root belongs inside the harness dir, not its parent — a previous
# double-dirname here put .fixtures-tmp one level too high, outside
# harness/.gitignore's coverage; caught during Phase 6 verification when it
# showed up as untracked embedded-git-repo content on `git add .lfd/`).
HARNESS_DIR="$(dirname "$SCRIPT_DIR")"

# Parse arguments
CLEAN=false
FIXTURES_ROOT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --clean)
            CLEAN=true
            shift
            ;;
        --root)
            FIXTURES_ROOT="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

# Set default FIXTURES_ROOT if not provided
if [[ -z "$FIXTURES_ROOT" ]]; then
    FIXTURES_ROOT="$HARNESS_DIR/.fixtures-tmp"
else
    # Make it absolute if relative
    if [[ ! "$FIXTURES_ROOT" = /* ]]; then
        FIXTURES_ROOT="$HARNESS_DIR/$FIXTURES_ROOT"
    fi
fi

# Clean if requested
if [[ "$CLEAN" == true ]]; then
    rm -rf "$FIXTURES_ROOT"
fi

# Create base directories
mkdir -p "$FIXTURES_ROOT/remotes"
mkdir -p "$FIXTURES_ROOT/repos"

# Project slugs
SLUGS=("va-jobs-platform" "corporate-site" "customer-portal" "billing-api")

# Create fixtures for each slug
for SLUG in "${SLUGS[@]}"; do
    REMOTE_PATH="$FIXTURES_ROOT/remotes/${SLUG}.git"
    REPO_PATH="$FIXTURES_ROOT/repos/$SLUG"

    # Create bare remote
    git init --bare "$REMOTE_PATH" >/dev/null 2>&1

    # Create working checkout
    # Try with -b flag first (git 2.28+)
    if git init -b main "$REPO_PATH" >/dev/null 2>&1; then
        :
    else
        # Fallback for older git
        git init "$REPO_PATH" >/dev/null 2>&1
    fi

    # Enter the repo and set it up
    (
        cd "$REPO_PATH"

        # If init didn't use -b flag, switch to main branch now
        if ! git rev-parse --verify main >/dev/null 2>&1; then
            git checkout -b main >/dev/null 2>&1
        fi

        # Set local git config
        git config core.hooksPath /dev/null
        git config user.name "DCC Fixture"
        git config user.email "fixture@example.invalid"

        # Create scripts directory
        mkdir -p scripts

        # Create package.json
        cat > package.json <<EOF
{
  "name": "$SLUG",
  "version": "0.0.0",
  "scripts": {
    "install": "bash scripts/ok.sh",
    "lint": "bash scripts/lint.sh",
    "typecheck": "bash scripts/ok.sh",
    "test": "bash scripts/ok.sh",
    "build": "bash scripts/ok.sh"
  }
}
EOF

        # Create scripts/ok.sh
        cat > scripts/ok.sh <<'OKEOF'
#!/usr/bin/env bash
echo ok
exit 0
OKEOF
        chmod +x scripts/ok.sh

        # Create scripts/lint.sh
        cat > scripts/lint.sh <<'LINTEOF'
#!/usr/bin/env bash
if [[ -f .lint-should-fail ]]; then
    echo "lint: forced failure via .lint-should-fail marker" >&2
    exit 1
fi
exit 0
LINTEOF
        chmod +x scripts/lint.sh

        # Create README.md
        cat > README.md <<EOF
# $SLUG

Fixture project for testing.
EOF

        # Create .gitignore
        cat > .gitignore <<EOF
node_modules/
.lint-should-fail
EOF

        # Initial commit
        git add -A >/dev/null 2>&1
        git commit -m "initial commit" >/dev/null 2>&1

        # Add remote and push
        git remote add origin "$REMOTE_PATH"
        git push -u origin main >/dev/null 2>&1

        # Special case: customer-portal should be dirty
        if [[ "$SLUG" == "customer-portal" ]]; then
            echo "" >> README.md
            echo "<!-- uncommitted local edit -->" >> README.md
        fi
    )
done

# Print summary
echo ""
echo "=== Git Fixtures Summary ==="
for SLUG in "${SLUGS[@]}"; do
    REPO_PATH="$FIXTURES_ROOT/repos/$SLUG"
    REMOTE_PATH="$FIXTURES_ROOT/remotes/${SLUG}.git"

    # Check if dirty
    if git -C "$REPO_PATH" status --porcelain 2>/dev/null | grep -q .; then
        STATUS="dirty"
    else
        STATUS="clean"
    fi

    echo "$SLUG: $REPO_PATH ($STATUS)"

    # Convert slug to env var name (replace hyphens with underscores, uppercase)
    ENV_SLUG=$(echo "$SLUG" | tr '[:lower:]' '[:upper:]' | tr '-' '_')
    echo "FIXTURE_REPO_${ENV_SLUG}=$REPO_PATH"
    echo "FIXTURE_REMOTE_${ENV_SLUG}=$REMOTE_PATH"
done

exit 0
