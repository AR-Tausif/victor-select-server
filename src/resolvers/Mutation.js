const bcrypt = require("bcryptjs");
const { randomBytes } = require("crypto");
const { promisify } = require("util");
const { sendResetMail } = require("../mail");
const { createTokens } = require("../auth");
const { saveCreditCard } = require("../usaepay/usaepay");
const { createCustomerProfile } = require("../authorizenet/Customer");

const setUser = (user, ctx) => {
  const tokens = createTokens(user);
  ctx.res.cookie("refresh-token", tokens.refreshToken, { httpOnly: true });
  ctx.res.cookie("access-token", tokens.accessToken, { httpOnly: true });
};

async function createPrismaUser(ctx, idToken) {
  const user = await ctx.db.mutation.createUser({
    data: {
      identity: idToken.sub.split(`|`)[0],
      auth0id: idToken.sub.split(`|`)[1],
      name: idToken.name,
      email: idToken.email
    }
  });
  return user;
}

const validateUser = async (userId, db) => {
  if (!userId) {
    throw new Error("You must be logged in to do this");
  }
  const user = await db.query.user({ where: { id: userId } });
  if (!user) {
    throw new Error(`Can't find user ID: ${userId}`);
  }

  return user;
};

const ctxUser = ctx => ctx.request.user;

const Mutation = {
  logout: async (_, __, { res, req }) => {
    req.userId = null;
    res.clearCookie("access-token");
    res.clearCookie("refresh-token");
    return true;
  },
  register: async (_, args, ctx, info) => {
    args.email = args.email.toLowerCase();
    const user = await ctx.db.query.user({ where: { email: args.email } });
    console.log("Register User:", user);
    const hashedPassword = await bcrypt.hash(args.password, 10);
    if (user) {
      if (user.role === "PATIENT") {
        return { message: "EXISTS" };
      }
      if (user.role === "VISITOR") {
        // Update information
        // copy the updates
        const updateUser = await ctx.db.mutation.updateUser({
          where: { email: args.email },
          data: { ...args, password: hashedPassword }
        });
        console.log("UpdateUser:", updateUser);
        setUser(updateUser, ctx);
        return { message: "OK" };
      }
    }

    console.log(args.email);
    const newUser = await ctx.db.mutation.createUser({
      data: {
        ...args,
        password: hashedPassword
      }
    });
    setUser(newUser, ctx);

    return { message: "OK" };
  },
  login: async (_, { email, password }, ctx) => {
    // 1. Check for a user with that email address
    email = email.toLowerCase();
    const user = await ctx.db.query.user({ where: { email } });
    if (!user) {
      throw new Error("Invalid email or password.");
    }
    // 2. Check if password is correct
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      throw new Error("Invalid email or password");
    }

    // Set the cookies with the token...
    setUser(user, ctx);
    //    const tokens = createTokens(user);
    //    ctx.res.cookie("refresh-token", tokens.refreshToken, { httpOnly: true });
    //    ctx.res.cookie("access-token", tokens.accessToken, { httpOnly: true });

    return user;
  },
  async requestReset(_, args, ctx) {
    // 1. Check if this is a real user
    const user = await ctx.db.query.user({ where: { email: args.email } });
    if (!user) {
      throw new Error(`No such user found for email ${args.email}`);
    }
    // 2. Set a reset token and expiry on that user
    const randomBytesPromiseified = promisify(randomBytes);
    const resetToken = (await randomBytesPromiseified(20)).toString("hex");
    const resetTokenExpiry = Date.now() + 3600000; // 1 hour from now
    const updateUser = await ctx.db.mutation.updateUser({
      where: { email: args.email },
      data: { resetToken, resetTokenExpiry }
    });
    console.log("UpdateUser:", updateUser);
    // 3. Email them that reset token
    const url = `${process.env.FRONTEND_URL}/reset?resetToken=${resetToken}`;
    sendResetMail({ email: args.email, name: updateUser.firstName, url });

    // 4. Return the message
    return { message: "Thanks!" };
  },
  async resetPassword(_, args, ctx) {
    // 1. check if the passwords match
    if (args.password !== args.confirmPassword) {
      throw new Error("Yo Passwords don't match!");
    }
    // 2. check if its a legit reset token
    // 3. Check if its expired
    const [user] = await ctx.db.query.users({
      where: {
        resetToken: args.resetToken,
        resetTokenExpiry_gte: Date.now() - 3600000
      }
    });
    if (!user) {
      throw new Error("This token is either invalid or expired!");
    }
    // 4. Hash their new password
    const password = await bcrypt.hash(args.password, 10);
    // 5. Save the new password to the user and remove old resetToken fields
    const updatedUser = await ctx.db.mutation.updateUser({
      where: { email: user.email },
      data: {
        password,
        resetToken: null,
        resetTokenExpiry: null
      }
    });
    // 6. Generate JWT
    // Set the cookies with the token...
    setUser(updatedUser, ctx);
    //    const tokens = createTokens(updatedUser);
    //    ctx.res.cookie("refresh-token", tokens.refreshToken, { httpOnly: true });
    //    ctx.res.cookie("access-token", tokens.accessToken, { httpOnly: true });

    // 8. return the new user
    return updatedUser;
  },
  invalidateTokens: async (_, __, { req, db }) => {
    console.log("Invalidate:", req);
    if (!req.userId) {
      return false;
    }

    const user = await db.query.user({ where: { id: req.userId } });
    if (!user) {
      return false;
    }
    const count = user.count + 1;
    await db.mutation.updateUser({
      data: { count },
      where: { id: req.userId }
    });
    res.clearCookie("access-token");

    return true;
  },
  async saveCard(_, args, { req, db }) {
    await validateUser(req.userId, db);
    const { input } = args;
    const savedCard = await saveCreditCard(input);
    if (savedCard) {
      const newCC = await db.mutation.createCreditCard({
        data: {
          ccType: savedCard.type,
          ccToken: savedCard.key,
          ccNumber: savedCard.cardnumber,
          ccExpire: cardInput.expiration,
          user: {
            connect: {
              id: req.userId
            }
          }
        }
      });
      await db.mutation.updateUser({
        where: { id: req.userId },
        data: {
          currentCard: newCC.id
        }
      });
      console.log("NewCC", newCC);
      return newCC;
    }
  },
  async saveAddress(_, args, { req, db }) {
    await validateUser(req.userId, db);
    const { input } = args;
    console.log("SaveAddress:", input);
    const newAddress = await db.mutation.createAddress({
      data: {
        ...input,
        user: {
          connect: {
            id: req.userId
          }
        }
      }
    });
    await db.mutation.updateUser({
      where: { id: req.userId },
      data: {
        currentAddress: newAddress.id
      }
    });
    return newAddress;
  }
};

module.exports = { Mutation };

//  createVisit(
//    questionaire: Json!
//    addressOne: String!
//    addressTwo: String
//    city: String!
//    state: String!
//    zipcode: String!
//    telephone: String!
