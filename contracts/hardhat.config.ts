import type { HardhatUserConfig } from 'hardhat/config';

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.20',
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  paths: {
    // Hardhat resolves these relative to the project root (cwd), not the config file path.
    // We keep Solidity sources isolated under /contracts to avoid picking up node_modules/*.sol.
    sources: './contracts',
    artifacts: './contracts/artifacts',
    cache: './contracts/cache',
  },
};

export default config;

