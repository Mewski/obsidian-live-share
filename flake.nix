{
  description = "Obsidian Live Share";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            nodePackages.typescript
            nodePackages.typescript-language-server
          ];

          shellHook = ''
            export PATH="$PWD/server/node_modules/.bin:$PWD/plugin/node_modules/.bin:$PATH"
          '';
        };
      }
    );
}
