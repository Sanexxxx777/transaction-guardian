
export interface TokenMeta {
  symbol: string;
  decimals: number;
}

const TOKENS: Record<number, Record<string, TokenMeta>> = {
  1: {
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
    '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 },
    '0x83f20f44975d03b1b09e64809b757c47f942beea': { symbol: 'sDAI', decimals: 18 },
    '0x4c9edd5852cd905f086c759e8383e09bff1e68b3': { symbol: 'USDe', decimals: 18 },
    '0x9d39a5de30e57443bff2a8307a4256c8797a3497': { symbol: 'sUSDe', decimals: 18 },
    '0x853d955acef822db058eb8505911ed77f175b99e': { symbol: 'FRAX', decimals: 18 },
    '0x5f98805a4e8be255a32880fdec7f6728c6568ba0': { symbol: 'LUSD', decimals: 18 },
    '0x57e114b691db790c35207b2e685d4a43181e6061': { symbol: 'ENA', decimals: 18 },

    '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': { symbol: 'ETH', decimals: 18 },
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 },
    '0xae7ab96520de3a18e5e111b5eaab095312d7fe84': { symbol: 'stETH', decimals: 18 },
    '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0': { symbol: 'wstETH', decimals: 18 },
    '0xae78736cd615f374d3085123a210448e74fc6393': { symbol: 'rETH', decimals: 18 },
    '0xbe9895146f7af43049ca1c1ae358b0541ea49704': { symbol: 'cbETH', decimals: 18 },
    '0x5e8422345238f34275888049021821e8e08caa1f': { symbol: 'frxETH', decimals: 18 },
    '0xac3e018457b222d93114458476f3e3416abbe38f': { symbol: 'sfrxETH', decimals: 18 },
    '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee': { symbol: 'weETH', decimals: 18 },
    '0xbf5495efe5db9ce00f80364c8b423567e58d2110': { symbol: 'ezETH', decimals: 18 },
    '0xa35b1b31ce002fbf2058d22f30f95d405200a15b': { symbol: 'rsETH', decimals: 18 },
    '0xf951e335afb289353dc249e82926178eac7ded78': { symbol: 'swETH', decimals: 18 },

    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC', decimals: 8 },
    '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': { symbol: 'cbBTC', decimals: 8 },
    '0x18084fba666a33d37592fa2633fd49a74dd93a88': { symbol: 'tBTC', decimals: 18 },

    '0x514910771af9ca656af840dff83e8264ecf986ca': { symbol: 'LINK', decimals: 18 },
    '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': { symbol: 'UNI', decimals: 18 },
    '0xd533a949740bb3306d119cc777fa900ba034cd52': { symbol: 'CRV', decimals: 18 },
    '0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b': { symbol: 'CVX', decimals: 18 },
    '0x6982508145454ce325ddbe47a25d4ec3d2311933': { symbol: 'PEPE', decimals: 18 },
    '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce': { symbol: 'SHIB', decimals: 18 },
    '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': { symbol: 'AAVE', decimals: 18 },
    '0xc944e90c64b2c07662a292be6244bdf05cda44a7': { symbol: 'GRT', decimals: 18 },
    '0x6810e776880c02933d47db1b9fc05908e5386b96': { symbol: 'GNO', decimals: 18 },
    '0x5283d291dbcf85356a21ba090e6db59121208b44': { symbol: 'BLUR', decimals: 18 },
    '0x4d224452801aced8b2f0aebe155379bb5d594381': { symbol: 'APE', decimals: 18 },
    '0xb50721bcf8d664c30412cfbc6cf7a15145234ad1': { symbol: 'ARB', decimals: 18 },
    '0xba100000625a3754423978a60c9317c58a424e3d': { symbol: 'BAL', decimals: 18 },
    '0x4691937a7508860f876c9c0a2a617e7d9e945d4b': { symbol: 'WOO', decimals: 18 },
    '0xcdf7028ceab81fa0c6971208e83fa7872994bee5': { symbol: 'TAO', decimals: 9 },
    '0x6c3ea9036406852006290770bedfcaba0e23a0e8': { symbol: 'PYUSD', decimals: 6 },
    '0xd33526068d116ce69f19a9ee46f0bd304f21a51f': { symbol: 'RPL', decimals: 18 },
    '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2': { symbol: 'MKR', decimals: 18 },
  },

  42161: {
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC', decimals: 6 },
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': { symbol: 'USDC.e', decimals: 6 },
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', decimals: 6 },
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18 },
    '0x17fc002b466eec40dae837fc4be5c67993ddbd6f': { symbol: 'FRAX', decimals: 18 },
    '0x93b346b6bc2548da6a1e7d98e9a421b42541425b': { symbol: 'LUSD', decimals: 18 },

    '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': { symbol: 'ETH', decimals: 18 },
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { symbol: 'WETH', decimals: 18 },
    '0x5979d7b546e38e414f7e9822514be443a4800529': { symbol: 'wstETH', decimals: 18 },
    '0xec70dcb4a1efa46b8f2d97c310c9c4790ba5ffa8': { symbol: 'rETH', decimals: 18 },
    '0x35751007a407ca6feffe80b3cb397736d2cf4dbe': { symbol: 'weETH', decimals: 18 },
    '0x2416092f143378750bb29b79ed961ab195cceea5': { symbol: 'ezETH', decimals: 18 },
    '0x4186bfc76e2e237523cbc30fd220fe055156b41f': { symbol: 'rsETH', decimals: 18 },
    '0x1debd73e752beaf79865fd6446b0c970eae7732f': { symbol: 'cbETH', decimals: 18 },

    '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': { symbol: 'WBTC', decimals: 8 },
    '0x6dab3bcbfb336b29d06b9c793aef7eaa57888922': { symbol: 'tBTC', decimals: 18 },

    '0x912ce59144191c1204e64559fe8253a0e49e6548': { symbol: 'ARB', decimals: 18 },
    '0x539bde0d7dbd336b79148aa742883198bbf60342': { symbol: 'MAGIC', decimals: 18 },
    '0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a': { symbol: 'GMX', decimals: 18 },
    '0x53691596d1bce8cea565b84d4915e69e03d9c99d': { symbol: 'ACX', decimals: 18 },
    '0x080f6aed32fc474dd5717105dba5ea57268f46eb': { symbol: 'SYN', decimals: 18 },
    '0x10393c20975cf177a3513071bc110f7962cd67da': { symbol: 'JONES', decimals: 18 },
    '0x9c2c5fd7b07e95ee044ddeba0e97a665f142394f': { symbol: '1INCH', decimals: 18 },
    '0x18c11fd286c5ec11c3b683caa813b77f5163a122': { symbol: 'GNS', decimals: 18 },
    '0xf97f4df75117a78c1a5a0dbb814af92458539fb4': { symbol: 'LINK', decimals: 18 },
    '0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0': { symbol: 'UNI', decimals: 18 },
    '0x11cdb42b0eb46d95f990bedd4695a6e3fa034978': { symbol: 'CRV', decimals: 18 },
    '0xba5ddd1f9d7f570dc94a51479a000e3bce967196': { symbol: 'AAVE', decimals: 18 },
    '0x040d1edc9569d4bab2d15287dc5a4f10f56a56b8': { symbol: 'BAL', decimals: 18 },
    '0x6694340fc020c5e6b96567843da2df01b2ce1eb6': { symbol: 'STG', decimals: 18 },
    '0x0c880f6761f1af8d9aa9c466984b80dab9a8c9e8': { symbol: 'PENDLE', decimals: 18 },
  },

  8453: {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', decimals: 6 },
    '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': { symbol: 'USDT', decimals: 6 },
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI', decimals: 18 },
    '0xeb466342c4d449bc9f53a865d5cb90586f405215': { symbol: 'axlUSDC', decimals: 6 },
    '0xcfa3ef56d303ae4faaba0592388f19d7c3399fb4': { symbol: 'eUSD', decimals: 18 },

    '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': { symbol: 'ETH', decimals: 18 },
    '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
    '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452': { symbol: 'wstETH', decimals: 18 },
    '0xb6fe221fe9eef5aba221c348ba20a1bf5e73624c': { symbol: 'rETH', decimals: 18 },
    '0x04c0599ae5a44757c0af6f9ec3b93da8976c150a': { symbol: 'weETH', decimals: 18 },
    '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': { symbol: 'cbETH', decimals: 18 },
    '0x2416092f143378750bb29b79ed961ab195cceea5': { symbol: 'ezETH', decimals: 18 },

    '0x0555e30da8f98308edb960aa94c0db47230d2b9c': { symbol: 'WBTC', decimals: 8 },
    '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': { symbol: 'cbBTC', decimals: 8 },

    '0x4ed4e862860bed51a9570b96d89af5e1b0efefed': { symbol: 'DEGEN', decimals: 18 },
    '0x9a26f5433671751144a8867b86958f4c4f8526e7': { symbol: 'BASE', decimals: 18 },
    '0x940181a94a35a4569e4529a3cdfb74e38fd98631': { symbol: 'AERO', decimals: 18 },
    '0x9e1028f5f1d5ede59748ffcee5532509976840e0': { symbol: 'COMP', decimals: 18 },
    '0xfa980ced6895ac314e7de34ef1bfae90a5add21b': { symbol: 'PRIME', decimals: 18 },
    '0xb3b32f9f8827d4634fe7d973fa1034ec9fddb3b3': { symbol: 'BLAST', decimals: 18 },
    '0x09a3eb19c5cb89bb87bce72cee7ce8d4cf1b2bd7': { symbol: 'MOG', decimals: 18 },
  },

  137: {
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { symbol: 'USDC', decimals: 6 },
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': { symbol: 'USDC.e', decimals: 6 },
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { symbol: 'USDT', decimals: 6 },
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': { symbol: 'DAI', decimals: 18 },
    '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': { symbol: 'MATIC', decimals: 18 },
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': { symbol: 'WMATIC', decimals: 18 },
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': { symbol: 'WETH', decimals: 18 },
    '0x03b54a6e9a984069379fae1a4fc4dbae93b3bccd': { symbol: 'wstETH', decimals: 18 },
    '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': { symbol: 'WBTC', decimals: 8 },
    '0xd6df932a45c0f255f85145f286ea0b292b21c90b': { symbol: 'AAVE', decimals: 18 },
    '0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39': { symbol: 'LINK', decimals: 18 },
    '0x172370d5cd63279efa6d502dab29171933a610af': { symbol: 'CRV', decimals: 18 },
    '0xb33eaad8d922b1083446dc23f610c2567fb5180f': { symbol: 'UNI', decimals: 18 },
    '0x9a71012b13ca4d3d0cdc72a177df3ef03b0e76a3': { symbol: 'BAL', decimals: 18 },
  },

  100: {
    '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83': { symbol: 'USDC', decimals: 6 },
    '0x4ecaba5870353805a9f068101a40e0f32ed605c6': { symbol: 'USDT', decimals: 6 },
    '0xe91d153e0b41518a2ce8dd3d7944fa863463a97d': { symbol: 'WXDAI', decimals: 18 },
    '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': { symbol: 'xDAI', decimals: 18 },
    '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1': { symbol: 'WETH', decimals: 18 },
    '0x9c58bacc331c9aa871afd802db6379a98e80cedb': { symbol: 'GNO', decimals: 18 },
    '0xcb444e90d8198415266c6a2724b7900fb12fc56e': { symbol: 'EURe', decimals: 18 },
    '0x0acd91f92fe07606ab51ea97d8521e29d110fd09': { symbol: 'wstETH', decimals: 18 },
  },
};

export function lookupToken(chainId: number, address: string): TokenMeta | null {
  const map = TOKENS[chainId];
  if (!map) return null;
  return map[address.toLowerCase()] || null;
}
