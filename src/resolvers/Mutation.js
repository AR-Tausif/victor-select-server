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

const validateUser = async (userId, prisma) => {
  if (!userId) {
    throw new Error("You must be logged in to do this");
  }
  const user = await prisma.user({ id: userId });
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
  register: async (_, args, ctx) => {
    const { prisma } = ctx;
    const { input } = args;
    input.email = input.email.toLowerCase();
    const user = await prisma.user({ email: input.email });
    console.log("Register User:", user);
    input.password = await bcrypt.hash(input.password, 10);
    if (user) {
      if (user.role === "PATIENT") {
        return { message: "EXISTS" };
      }
      if (user.role === "VISITOR") {
        // Update information
        // copy the updates
        const updateUser = await prisma.updateUser({
          where: { email: input.email },
          data: { ...input }
        });
        console.log("UpdateUser:", updateUser);
        setUser(updateUser, ctx);
        return { message: "OK" };
      }
    }

    console.log(args.email);
    const newUser = await prisma.createUser({ ...input });
    setUser(newUser, ctx);

    return { message: "OK" };
  },
  login: async (_, { email, password }, ctx) => {
    const { prisma } = ctx;
    // 1. Check for a user with that email address
    email = email.toLowerCase();
    const user = await prisma.user({ email });
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

    return user;
  },

  requestReset: async (_, args, { prisma }) => {
    // 1. Check if this is a real user
    const user = await prisma.user({ email: args.email });
    if (!user) {
      throw new Error(`No such user found for email ${args.email}`);
    }
    // 2. Set a reset token and expiry on that user
    const randomBytesPromiseified = promisify(randomBytes);
    const resetToken = (await randomBytesPromiseified(20)).toString("hex");
    const resetTokenExpiry = Date.now() + 3600000; // 1 hour from now
    const updateUser = await prisma.updateUser({
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

  resetPassword: async (_, args, ctx) => {
    const { prisma } = ctx;
    // 1. check if the passwords match
    if (args.password !== args.confirmPassword) {
      throw new Error("Yo Passwords don't match!");
    }
    // 2. check if its a legit reset token
    // 3. Check if its expired
    const [user] = await prisma.users({
      where: {
        AND: [
          { resetToken: args.resetToken },
          { resetTokenExpiry_gte: Date.now() - 3600000 }
        ]
      }
    });
    if (!user) {
      throw new Error("This token is either invalid or expired!");
    }
    // 4. Hash their new password
    const password = await bcrypt.hash(args.password, 10);
    // 5. Save the new password to the user and remove old resetToken fields
    const updatedUser = await prisma.updateUser({
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
    // 8. return the new user
    return updatedUser;
  },

  invalidateTokens: async (_, __, { req, prisma }) => {
    console.log("Invalidate:", req);
    if (!req.userId) {
      return false;
    }

    const user = await prisma.user({ id: req.userId });
    if (!user) {
      return false;
    }
    const count = user.count + 1;
    await prisma.updateUser({
      data: { count },
      where: { id: req.userId }
    });
    res.clearCookie("access-token");

    return true;
  },

  saveCard: async (_, args, { req, prisma }) => {
    await validateUser(req.userId, prisma);
    const { input } = args;

    const savedCard = await saveCreditCard(input);
    if (savedCard) {
      // Update all current user credit cards to inactive
      await prisma.updateManyCreditCards({
        where: { user: { id: req.userId }, active: true },
        data: { active: false }
      });
      // Save new active card
      const newCC = await prisma.createCreditCard({
        ccType: savedCard.type,
        ccToken: savedCard.key,
        ccNumber: savedCard.cardnumber,
        ccExpire: input.expiration,
        active: true,
        user: {
          connect: {
            id: req.userId
          }
        }
      });

      console.log("NewCC", newCC);
      return newCC;
    } else {
      throw new Error("Unable to process credit card");
    }
  },

  async saveAddress(_, args, { req, prisma }) {
    await validateUser(req.userId, prisma);
    const { input } = args;
    console.log("SaveAddress:", input);

    // Update all current user addresses to inactive
    await prisma.updateManyAddresses({
      where: { user: { id: req.userId }, active: true },
      data: { active: false }
    });

    // See if there is a matching address
    const [tmpAddress] = await prisma.addresses({
      where: {
        user: { id: req.userId },
        ...input
      }
    });

    var address;
    if (!tmpAddress) {
      address = await prisma.createAddress({
        ...input,
        active: true,
        user: {
          connect: {
            id: req.userId
          }
        }
      });
    } else {
      address = await prisma.updateAddress({
        where: { id: tmpAddress.id },
        data: {
          active: true
        }
      });
    }

    // Update all other address to active == false

    return address;
  },

  saveTmpVisit: async (_, args, { req, prisma }) => {
    await validateUser(req.userId, prisma);
    const { input } = args;
    ///  Check for current visit
    const [visit] = await prisma.visits({
      where: {
        user: { id: req.userId },
        type: input.type,
        status: "TEMPORARY"
      }
    });
    console.log("Visits:", visit);

    return prisma.upsertVisit({
      where: { id: visit ? visit.id : "" },
      update: {
        ...input,
        user: {
          connect: {
            id: req.userId
          }
        }
      },
      create: {
        ...input,
        user: {
          connect: {
            id: req.userId
          }
        }
      }
    });
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
