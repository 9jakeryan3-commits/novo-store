module.exports = (req, res) => {
  res.status(200).json({
    price: process.env.PRICE_DISPLAY || '2199',
  });
};
