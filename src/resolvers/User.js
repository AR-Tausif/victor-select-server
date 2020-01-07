const User = {
  email: {
    fragment: `fragment UserId on User { id }`,
    resolve: (parent, args, ctx, info) => {
      return parent.email;
    }
  },
  addresses: ({ id }, args, context) => {
    return context.prisma.user({ id }).addresses();
  },
  creditCards: ({ id }, args, context) => {
    return context.prisma.user({ id }).creditCards();
  },
  visits: ({ id }, args, context) => {
    return context.prisma.user({ id }).visits();
  }
};

module.exports = { User };
