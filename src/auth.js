const { sign } = require("jsonwebtoken");

const createTokens = user => {
  const refreshToken = sign(
    { userId: user.id, count: user.count },
    process.env.REFRESH_TOKEN_SECRET,
    {
      expiresIn: "1d"
    }
  );

  const accessToken = sign(
    { userId: user.id },
    process.env.ACCESS_TOKEN_SECRET,
    {
      expiresIn: "60min"
    }
  );

  return { refreshToken, accessToken };
};

module.exports = { createTokens };
