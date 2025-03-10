module.exports = (req, res, next) => {
  if (!req.session.user) {
    return res.redirect("/login"); // Redirect to login if not logged in
  }
  next();
};
