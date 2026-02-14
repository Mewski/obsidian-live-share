{
  description = "Obsidian Live Share — server + plugin dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        nodejs = pkgs.nodejs_22;
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            nodejs
            pkgs.nodePackages.typescript
            pkgs.nodePackages.typescript-language-server
          ];

          shellHook = ''
            echo "obsidian-live-share dev shell"
            echo "  nix run .#server    — start the relay server"
            echo "  nix run .#build     — build both packages"
            echo "  nix run .#test      — run all tests"
            export PATH="$PWD/server/node_modules/.bin:$PWD/plugin/node_modules/.bin:$PATH"
          '';
        };

        apps = {
          server = {
            type = "app";
            program = toString (
              pkgs.writeShellScript "run-server" ''
                set -e
                cd ${toString ./.}/server
                if [ ! -d node_modules ]; then
                  ${nodejs}/bin/npm install
                fi
                ${nodejs}/bin/npx tsx src/index.ts
              ''
            );
          };

          build = {
            type = "app";
            program = toString (
              pkgs.writeShellScript "build-all" ''
                set -e
                cd ${toString ./.}

                echo "==> installing server deps"
                cd server
                ${nodejs}/bin/npm install
                ${nodejs}/bin/npx tsc
                cd ..

                echo "==> installing plugin deps"
                cd plugin
                ${nodejs}/bin/npm install
                ${nodejs}/bin/node esbuild.config.mjs production
                cd ..

                echo "==> done"
                echo "server: server/dist/"
                echo "plugin: plugin/main.js, plugin/manifest.json, plugin/styles.css"
              ''
            );
          };

          test = {
            type = "app";
            program = toString (
              pkgs.writeShellScript "run-tests" ''
                set -e
                cd ${toString ./.}

                echo "==> server tests"
                cd server
                if [ ! -d node_modules ]; then ${nodejs}/bin/npm install; fi
                ${nodejs}/bin/npx vitest run
                cd ..

                echo "==> plugin tests"
                cd plugin
                if [ ! -d node_modules ]; then ${nodejs}/bin/npm install; fi
                ${nodejs}/bin/npx vitest run
                cd ..

                echo "==> all tests passed"
              ''
            );
          };

          install-plugin = {
            type = "app";
            program = toString (
              pkgs.writeShellScript "install-plugin" ''
                set -e
                VAULT_DIR="''${1:-}"
                if [ -z "$VAULT_DIR" ]; then
                  echo "usage: nix run .#install-plugin -- /path/to/vault"
                  exit 1
                fi
                PLUGIN_DIR="$VAULT_DIR/.obsidian/plugins/obsidian-live-share"
                mkdir -p "$PLUGIN_DIR"
                cp ${toString ./.}/plugin/main.js "$PLUGIN_DIR/"
                cp ${toString ./.}/plugin/manifest.json "$PLUGIN_DIR/"
                cp ${toString ./.}/plugin/styles.css "$PLUGIN_DIR/"
                echo "installed to $PLUGIN_DIR"
              ''
            );
          };
        };

        # Default app is the server
        apps.default = self.apps.${system}.server;
      }
    );
}
